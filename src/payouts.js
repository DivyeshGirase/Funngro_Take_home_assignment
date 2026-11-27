const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { Payout, Wallet, Ledger, Outbox, transactionOptions } = require('./withdraw');

// Explicit state machine. Terminal states have no outgoing transitions.
const transitions = {
  pending: ['processing'],
  processing: ['unknown', 'succeeded', 'failed'],
  unknown: ['unknown', 'succeeded', 'failed'],
  succeeded: [],
  failed: []
};
function assertTransition(from, to) {
  if (!transitions[from]?.includes(to)) throw new Error('Invalid payout transition');
}
const terminal = status => status === 'succeeded' || status === 'failed';
const ownership = job => ({ _id: job._id, state: 'claimed', leaseToken: job.leaseToken });

async function claimJob({ leaseMs = 30000, now = new Date() } = {}) {
  return Outbox.findOneAndUpdate({
    type: 'send_payout',
    $or: [
      { state: 'pending', availableAt: { $lte: now } },
      { state: 'pending', availableAt: { $exists: false } },
      { state: 'claimed', leaseUntil: { $lte: now } }
    ]
  }, {
    $set: { state: 'claimed', leaseToken: randomUUID(), leaseUntil: new Date(+now + leaseMs) },
    $inc: { attempts: 1 }
  }, { new: true, sort: { createdAt: 1 }, writeConcern: { w: 'majority' } }).lean();
}

async function prepare(job) {
  return mongoose.connection.transaction(async session => {
    // Write the outbox document so concurrent lease reclamation conflicts with this transaction.
    const owned = await Outbox.updateOne(ownership(job), { $set: { state: 'claimed' } }, { session });
    if (!owned.matchedCount) return null;
    const payout = await Payout.findById(job.payoutId).session(session).lean();
    if (!payout) throw new Error('Missing payout for outbox event');
    if (terminal(payout.status)) {
      await Outbox.updateOne(ownership(job), { $set: { state: 'done' } }, { session });
      return null;
    }
    const firstAttempt = payout.status === 'pending';
    if (firstAttempt) {
      assertTransition(payout.status, 'processing');
      await Payout.updateOne({ _id: payout._id, status: 'pending' }, {
        $set: { status: 'processing' }
      }, { session });
    }
    return { ...payout, firstAttempt };
  }, transactionOptions);
}

function isFinalFailure(result) {
  return result?.status === 'failed' && result.definitive === true;
}

async function settle(job, result) {
  if (result?.status !== 'succeeded' && !isFinalFailure(result)) {
    throw new Error('Confirmed success or definitive provider failure required');
  }
  const { status: outcome, id: gatewayPayoutId } = result;
  return mongoose.connection.transaction(async session => {
    const owned = await Outbox.updateOne(ownership(job), {
      $set: { state: 'done' }, $unset: { leaseToken: '', leaseUntil: '' }
    }, { session });
    if (!owned.matchedCount) return false; // Stale worker cannot mutate accounting.
    const payout = await Payout.findById(job.payoutId).session(session).lean();
    if (!payout) throw new Error('Missing payout');
    if (terminal(payout.status)) return false;
    assertTransition(payout.status, outcome);
    await Payout.updateOne({ _id: payout._id, status: payout.status }, {
      $set: { status: outcome, ...(gatewayPayoutId ? { gatewayPayoutId } : {}) }
    }, { session });
    if (outcome === 'failed') {
      const wallet = await Wallet.findOneAndUpdate({
        userId: payout.userId, currency: payout.currency,
        availablePaise: { $lte: Number.MAX_SAFE_INTEGER - payout.amountPaise }
      }, { $inc: { availablePaise: payout.amountPaise } }, { new: true, session });
      if (!wallet) throw new Error('Refund wallet missing or outside safe integer range');
      await Ledger.create([{
        eventId: `refund:${payout._id}`, userId: payout.userId, payoutId: payout._id,
        type: 'withdrawal_refunded', deltaPaise: payout.amountPaise,
        balanceAfterPaise: wallet.availablePaise
      }], { session });
    }
    // On success the reservation is the debit; no fabricated balance or second debit.
    return true;
  }, transactionOptions);
}

async function defer(job, retryMs) {
  await mongoose.connection.transaction(async session => {
    const owned = await Outbox.updateOne(ownership(job), {
      $set: { state: 'pending', availableAt: new Date(Date.now() + retryMs) },
      $unset: { leaseToken: '', leaseUntil: '' }
    }, { session });
    if (!owned.matchedCount) return;
    const payout = await Payout.findById(job.payoutId).session(session).lean();
    if (payout && !terminal(payout.status)) {
      assertTransition(payout.status, 'unknown');
      await Payout.updateOne({ _id: payout._id, status: payout.status }, {
        $set: { status: 'unknown' }
      }, { session });
    }
  }, transactionOptions);
}

// The adapter supplies bounded calls and normalizes results for the requested reference.
// canResubmit must confirm deduplication through provider acceptance, including delayed sends.
async function processPayout(job, gateway, { retryMs = 5000 } = {}) {
  const payout = await prepare(job);
  if (!payout) return;

  const reference = payout.gatewayReference;
  let result;
  try {
    if (!payout.firstAttempt) {
      result = await gateway.getByReference(reference);
    }
    if (payout.firstAttempt || (
      result?.status === 'not_found' && (await gateway.canResubmit?.(reference)) === true
    )) {
      result = await gateway.createPayout({
        reference, bankToken: payout.bankToken,
        amountPaise: payout.amountPaise, currency: payout.currency
      });
    }
  } catch {
    await defer(job, retryMs);
    return;
  }

  if (result?.status === 'succeeded' || isFinalFailure(result)) {
    return settle(job, result);
  }
  await defer(job, retryMs);
}

module.exports = { claimJob, prepare, settle, defer, processPayout };
