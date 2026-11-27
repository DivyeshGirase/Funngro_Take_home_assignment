const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { claimJob, prepare, settle, processPayout } = require('../src/payouts');
const {
  createApp, createIndexes, User, Wallet, DailyWithdrawal, Payout, Ledger, Outbox
} = require('../src/withdraw');

// No dotenv, Atlas URI, deleteMany or dropDatabase. Each test gets a new database
// on a disposable local replica set owned exclusively by this test process.
const secret = randomBytes(32).toString('hex');
const beforeMidnight = Date.parse('2026-11-26T18:29:59.999Z');
const afterMidnight = beforeMidnight + 1;
let now;
const app = createApp({ secret }, { now: () => now });
let replSet;
let user;
let token;
let logs;

function sign(id, options = {}) {
  return jwt.sign({}, secret, {
    subject: String(id), issuer: 'funngro-assessment', audience: 'funngro-api',
    expiresIn: '5m', ...options
  });
}
function withdraw(amountPaise = 40000, key = 'withdraw-001', auth = token, extra = {}) {
  const call = request(app).post('/api/wallet/withdraw').send({ amountPaise, ...extra });
  if (auth) call.set('Authorization', `Bearer ${auth}`);
  if (key) call.set('Idempotency-Key', key);
  return call;
}
const balance = async () => (await Wallet.findOne({ userId: user._id }).lean()).availablePaise;

beforeAll(async () => {
  logs = jest.spyOn(console, 'log').mockImplementation(() => {});
  replSet = await MongoMemoryReplSet.create({
    binary: { downloadDir: path.resolve('.cache/mongodb-binaries') },
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
});

beforeEach(async () => {
  now = beforeMidnight;
  if (!replSet) throw new Error('Local replica set did not start');
  await mongoose.connect(replSet.getUri(`funngro_test_${randomUUID().replaceAll('-', '')}`), {
    autoIndex: false, serverSelectionTimeoutMS: 10000
  });
  await createIndexes();
  user = await User.create({ bankToken: 'fake-bank-token', bankVerified: true, payoutEligible: true });
  await Wallet.create({ userId: user._id, currency: 'INR', availablePaise: 100000 });
  token = sign(user._id);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.disconnect();
  logs = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
  logs?.mockRestore();
});

test('request body userId cannot select another wallet', async () => {
  const otherId = new mongoose.Types.ObjectId();
  await Wallet.create({ userId: otherId, availablePaise: 900000 });
  const response = await withdraw(40000, 'withdraw-001', token, { userId: String(otherId) });
  expect(response.status).toBe(202);
  expect(await balance()).toBe(60000);
  expect((await Wallet.findOne({ userId: otherId })).availablePaise).toBe(900000);
  expect(String((await Payout.findById(response.body.payoutId)).userId)).toBe(String(user._id));
});

test('same key with different amount returns conflict', async () => {
  await withdraw();
  const response = await withdraw(50000);
  expect(response.status).toBe(409);
  expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect(await balance()).toBe(60000);
});

test('simultaneous duplicate requests produce exactly one reservation', async () => {
  const responses = await Promise.all([withdraw(), withdraw(), withdraw()]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 200, 202]);
  expect(new Set(responses.map(r => r.body.payoutId)).size).toBe(1);
  expect(await balance()).toBe(60000);
  for (const Model of [Payout, Ledger, Outbox]) expect(await Model.countDocuments()).toBe(1);
  expect(await DailyWithdrawal.findOne().lean()).toMatchObject({ usedPaise: 40000 });
});

test('two simultaneous withdrawals cannot overspend the wallet', async () => {
  const responses = await Promise.all([
    withdraw(80000, 'withdraw-001'), withdraw(80000, 'withdraw-002')
  ]);
  expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
  expect(await balance()).toBe(20000);
  for (const Model of [Payout, Ledger, Outbox]) expect(await Model.countDocuments()).toBe(1);
});

test('outbox write failure rolls back the debit, payout, daily usage and ledger', async () => {
  const failure = jest.spyOn(Outbox, 'create').mockRejectedValueOnce(new Error('Injected write failure'));
  expect((await withdraw()).status).toBe(500);
  expect(await balance()).toBe(100000);
  for (const Model of [DailyWithdrawal, Payout, Ledger, Outbox]) expect(await Model.countDocuments()).toBe(0);
  failure.mockRestore();
  expect((await withdraw()).status).toBe(202); // Failed transaction did not consume the key.
});

test('a submit timeout keeps funds reserved and recovery looks up the original reference', async () => {
  const { body: { payoutId } } = await withdraw();
  const reference = `WD-${payoutId}`;
  const gateway = {
    createPayout: jest.fn().mockRejectedValue(new Error('Gateway timed out')),
    getByReference: jest.fn().mockResolvedValue({ status: 'succeeded', id: 'provider-test-id' })
  };

  await processPayout(await claimJob(), gateway, { retryMs: 0 });
  expect(gateway.createPayout).toHaveBeenCalledWith(expect.objectContaining({ reference }));
  expect(gateway.getByReference).not.toHaveBeenCalled();
  expect((await Payout.findById(payoutId)).status).toBe('unknown');
  expect(await balance()).toBe(60000);
  expect(await Ledger.countDocuments()).toBe(1);

  await processPayout(await claimJob(), gateway);
  expect(gateway.getByReference).toHaveBeenCalledWith(reference);
  expect(gateway.createPayout).toHaveBeenCalledTimes(1);
  expect(await Payout.findById(payoutId)).toMatchObject({
    status: 'succeeded', gatewayPayoutId: 'provider-test-id'
  });
  expect(await balance()).toBe(60000);
  expect(await Ledger.countDocuments()).toBe(1);
});

test('nondefinitive failure cannot refund at the processor or settlement boundary', async () => {
  const { body: { payoutId } } = await withdraw();
  const failure = { status: 'failed', definitive: false };
  const job = await claimJob();
  await prepare(job);
  await expect(settle(job, failure)).rejects.toThrow('definitive provider failure');
  await expect(settle(job, { status: 'failed' })).rejects.toThrow('definitive provider failure');

  const gateway = { getByReference: jest.fn().mockResolvedValue(failure), createPayout: jest.fn() };
  await processPayout(job, gateway, { retryMs: 0 });
  expect(gateway.getByReference).toHaveBeenCalledWith(`WD-${payoutId}`);
  expect(gateway.createPayout).not.toHaveBeenCalled();
  expect((await Payout.findById(payoutId)).status).toBe('unknown');
  expect(await balance()).toBe(60000);
  expect(await Ledger.countDocuments()).toBe(1);

  gateway.getByReference.mockResolvedValue({ status: 'failed', definitive: true });
  const retry = await claimJob();
  expect(await processPayout(retry, gateway)).toBe(true);
  await processPayout(retry, gateway);
  expect((await Payout.findById(payoutId)).status).toBe('failed');
  expect(await balance()).toBe(100000);
  expect(await Ledger.countDocuments({ type: 'withdrawal_refunded' })).toBe(1);
  expect(await DailyWithdrawal.findOne().lean()).toMatchObject({ usedPaise: 40000 });
});

test('recovery resends only after not_found and a current deduplication guarantee', async () => {
  const { body: { payoutId } } = await withdraw();
  const reference = `WD-${payoutId}`;
  const gateway = {
    createPayout: jest.fn().mockResolvedValue({ status: 'pending' }),
    getByReference: jest.fn()
      .mockRejectedValueOnce(new Error('Lookup unavailable'))
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValue({ status: 'not_found' }),
    canResubmit: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  };

  await processPayout(await claimJob(), gateway, { retryMs: 0 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await processPayout(await claimJob(), gateway, { retryMs: 0 });
    expect(gateway.createPayout).toHaveBeenCalledTimes(1);
  }
  expect(gateway.canResubmit.mock.calls).toEqual([[reference]]);
  await processPayout(await claimJob(), gateway, { retryMs: 0 });
  expect(gateway.canResubmit.mock.calls).toEqual([[reference], [reference]]);
  expect(gateway.getByReference.mock.calls).toEqual(Array.from({ length: 4 }, () => [reference]));
  expect(gateway.createPayout).toHaveBeenCalledTimes(2);
  expect(gateway.createPayout.mock.calls[1]).toEqual(gateway.createPayout.mock.calls[0]);
  expect((await Payout.findById(payoutId)).status).toBe('unknown');
  expect(await balance()).toBe(60000);
  expect(await Ledger.countDocuments()).toBe(1);
});

test('a stale lease cannot settle and concurrent settlement refunds once', async () => {
  const response = await withdraw();
  const oldJob = await claimJob({ leaseMs: 1 });
  await prepare(oldJob);
  const currentJob = await claimJob({ now: new Date(+oldJob.leaseUntil + 1) });
  expect(await settle(oldJob, { status: 'failed', definitive: true })).toBe(false);
  expect(await balance()).toBe(60000);

  const results = await Promise.all([
    settle(currentJob, { status: 'failed', definitive: true }),
    settle(currentJob, { status: 'failed', definitive: true })
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(await balance()).toBe(100000);
  expect(await Ledger.countDocuments({ type: 'withdrawal_refunded' })).toBe(1);
  expect((await Payout.findById(response.body.payoutId)).status).toBe('failed');
});

async function fundWallet() {
  await Wallet.updateOne({ userId: user._id }, { $set: { availablePaise: 500000 } });
}

async function expectReservations(amounts, remaining) {
  expect(await balance()).toBe(remaining);
  const byAmount = (a, b) => a - b;
  expect((await Payout.find().lean()).map(p => p.amountPaise).sort(byAmount))
    .toEqual([...amounts].sort(byAmount));
  expect((await Ledger.find({ type: 'withdrawal_reserved' }).lean()).map(l => -l.deltaPaise).sort(byAmount))
    .toEqual([...amounts].sort(byAmount));
  expect(await Ledger.countDocuments()).toBe(amounts.length);
  expect(await Outbox.countDocuments()).toBe(amounts.length);
}

async function expectUsage(days, userId = user._id) {
  const records = await DailyWithdrawal.find({ userId }).sort({ day: 1 }).lean();
  expect(records.map(({ day, usedPaise }) => [day, usedPaise])).toEqual(days);
}

test('exactly 200000 paise is allowed and the next paise is rejected', async () => {
  await fundWallet();
  expect((await withdraw(200000)).status).toBe(202);
  const rejected = await withdraw(1, 'withdraw-extra');
  expect(rejected.status).toBe(409);
  expect(rejected.body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
  await expectUsage([['2026-11-26', 200000]]);
  await expectReservations([200000], 300000);
});

test('a single withdrawal above the limit makes no writes', async () => {
  await fundWallet();
  const rejected = await withdraw(200001);
  expect(rejected.status).toBe(409);
  expect(rejected.body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
  await expectUsage([]);
  await expectReservations([], 500000);
});

test('concurrent first withdrawals share one record and can total exactly the limit', async () => {
  await fundWallet();
  const responses = await Promise.all([withdraw(125000), withdraw(75000, 'withdraw-002')]);
  expect(responses.map(r => r.status)).toEqual([202, 202]);
  await expectUsage([['2026-11-26', 200000]]);
  await expectReservations([125000, 75000], 300000);
});

test('simultaneous 150000 and 100000 paise withdrawals cannot both commit', async () => {
  await fundWallet();
  const amounts = [150000, 100000];
  const responses = await Promise.all(amounts.map((amount, i) => withdraw(amount, `withdraw-${i}`)));
  expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
  expect(responses.find(r => r.status === 409).body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
  const accepted = amounts[responses.findIndex(r => r.status === 202)];
  await expectUsage([['2026-11-26', accepted]]);
  await expectReservations([accepted], 500000 - accepted);
});

test('a burst of eight requests commits only four 50000 paise withdrawals', async () => {
  await fundWallet();
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => withdraw(50000, `withdraw-${i}`)));
  expect(responses.map(r => r.status).sort()).toEqual([202, 202, 202, 202, 409, 409, 409, 409]);
  for (const response of responses.filter(r => r.status === 409)) {
    expect(response.body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
  }
  await expectUsage([['2026-11-26', 200000]]);
  await expectReservations(Array(4).fill(50000), 300000);
});

test('insufficient balance leaves quota and financial records untouched', async () => {
  const rejected = await withdraw(100001);
  expect(rejected.status).toBe(409);
  expect(rejected.body.error.code).toBe('INSUFFICIENT_BALANCE');
  await expectUsage([]);
  await expectReservations([], 100000);
});

test('different users can each withdraw their full limit using the same key', async () => {
  await fundWallet();
  const other = await User.create({ bankToken: 'other-test-token', bankVerified: true, payoutEligible: true });
  await Wallet.create({ userId: other._id, availablePaise: 500000 });
  const responses = await Promise.all([withdraw(200000), withdraw(200000, 'withdraw-001', sign(other._id))]);
  expect(responses.map(r => r.status)).toEqual([202, 202]);
  expect((await Wallet.findOne({ userId: other._id })).availablePaise).toBe(300000);
  await expectUsage([['2026-11-26', 200000]], other._id);
  await expectUsage([['2026-11-26', 200000]]);
  await expectReservations([200000, 200000], 300000);
});

test('midnight IST resets the quota and an old key still replays the existing payout', async () => {
  await fundWallet();
  const first = await withdraw(200000);
  expect(first.status).toBe(202);
  now = afterMidnight;
  const replay = await withdraw(200000);
  expect(replay.status).toBe(200);
  expect(replay.body.payoutId).toBe(first.body.payoutId);
  await expectUsage([['2026-11-26', 200000]]);
  expect((await withdraw(200000, 'withdraw-next')).status).toBe(202);
  await expectUsage([['2026-11-26', 200000], ['2026-11-27', 200000]]);
  await expectReservations([200000, 200000], 100000);
});

test('a Round 1 payout above the new limit remains replayable', async () => {
  const previous = await Payout.create({
    userId: user._id, idempotencyKey: 'withdraw-001', amountPaise: 250000,
    currency: 'INR', bankToken: user.bankToken, status: 'succeeded', gatewayReference: 'WD-legacy'
  });
  const response = await withdraw(250000);
  expect(response.status).toBe(200);
  expect(response.body.payoutId).toBe(String(previous._id));
  await expectUsage([]);
  expect(await balance()).toBe(100000);
  expect(await Payout.countDocuments()).toBe(1);
  expect(await Ledger.countDocuments()).toBe(0);
  expect(await Outbox.countDocuments()).toBe(0);
});

test('invalid amounts are rejected without creating a daily record', async () => {
  for (const amount of [0, -1, 1.5, '500', null, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await withdraw(amount);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_AMOUNT');
  }
  await expectUsage([]);
  await expectReservations([], 100000);
});
