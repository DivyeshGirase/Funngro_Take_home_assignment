const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { Schema, model } = mongoose;
const opts = { timestamps: true, autoIndex: false, autoCreate: false };
const objectId = { type: Schema.Types.ObjectId, required: true };
const integer = { type: Number, required: true, validate: Number.isSafeInteger };
const money = { ...integer, min: 0, max: Number.MAX_SAFE_INTEGER };

const User = model('User', new Schema({
  bankToken: { type: String, required: true },
  bankVerified: { type: Boolean, default: false },
  payoutEligible: { type: Boolean, default: false }
}, opts));

const walletSchema = new Schema({
  userId: objectId,
  currency: { type: String, enum: ['INR'], default: 'INR' },
  availablePaise: money
}, opts);
walletSchema.index({ userId: 1, currency: 1 }, { unique: true });
const Wallet = model('Wallet', walletSchema);

const dailyWithdrawalSchema = new Schema({
  userId: objectId,
  day: { type: String, required: true },
  usedPaise: money
}, opts);
dailyWithdrawalSchema.index({ userId: 1, day: 1 }, { unique: true });
const DailyWithdrawal = model('DailyWithdrawal', dailyWithdrawalSchema);

const payoutSchema = new Schema({
  userId: objectId,
  idempotencyKey: { type: String, required: true, immutable: true },
  amountPaise: { ...money, min: 1, immutable: true },
  currency: { type: String, required: true, enum: ['INR'], immutable: true },
  bankToken: { type: String, required: true, immutable: true },
  status: {
    type: String, required: true,
    enum: ['pending', 'processing', 'unknown', 'succeeded', 'failed'], default: 'pending'
  },
  gatewayReference: { type: String, required: true, immutable: true },
  gatewayPayoutId: String
}, opts);
payoutSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
payoutSchema.index({ gatewayReference: 1 }, { unique: true });
payoutSchema.index({ status: 1, createdAt: 1 });
const Payout = model('Payout', payoutSchema);

const ledgerSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  userId: objectId,
  payoutId: objectId,
  type: { type: String, required: true, enum: ['withdrawal_reserved', 'withdrawal_refunded'] },
  deltaPaise: integer,
  balanceAfterPaise: money
}, { ...opts, timestamps: { createdAt: true, updatedAt: false } });
ledgerSchema.index({ userId: 1, createdAt: -1, _id: -1 });
// Append-only through the application model. DB roles must enforce this in production.
ledgerSchema.pre('save', function () {
  if (!this.isNew) throw new Error('Ledger records are append-only');
});
for (const operation of [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite'
]) {
  ledgerSchema.pre(operation, function () { throw new Error('Ledger records are append-only'); });
}
ledgerSchema.pre('deleteOne', { document: true, query: false }, function () {
  throw new Error('Ledger records are append-only');
});
const Ledger = model('Ledger', ledgerSchema);

const outboxSchema = new Schema({
  eventId: { type: String, required: true, unique: true },
  payoutId: objectId,
  type: { type: String, enum: ['send_payout'], required: true },
  state: { type: String, enum: ['pending', 'claimed', 'done'], default: 'pending' },
  availableAt: { type: Date, default: Date.now },
  leaseUntil: Date,
  leaseToken: String,
  attempts: { type: Number, default: 0 }
}, opts);
outboxSchema.index({ state: 1, availableAt: 1, createdAt: 1 });
outboxSchema.index({ state: 1, leaseUntil: 1, createdAt: 1 });
const Outbox = model('Outbox', outboxSchema);

async function createIndexes() {
  // Never syncIndexes(): it can drop indexes created by another application.
  for (const Model of [User, Wallet, DailyWithdrawal, Payout, Ledger, Outbox]) {
    await Model.createCollection();
    await Model.createIndexes();
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Log only allowlisted fields. Database/gateway errors can contain secrets.
function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

function authenticate({ secret, issuer = 'funngro-assessment', audience = 'funngro-api' }) {
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes');
  }
  return (req, _res, next) => {
    try {
      const header = req.get('Authorization');
      if (!header?.startsWith('Bearer ')) throw new Error('Missing bearer token');
      const claims = jwt.verify(header.slice(7), secret, {
        algorithms: ['HS256'], issuer, audience
      });
      if (!Number.isInteger(claims.exp) || !mongoose.isObjectIdOrHexString(claims.sub)) {
        throw new Error('Invalid identity');
      }
      req.user = { id: claims.sub };
      next();
    } catch {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Valid authentication required'));
    }
  };
}

const transactionOptions = {
  readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }
};
const dailyLimitPaise = 200000;
const istDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', dateStyle: 'short' });

function dailyLimitError() {
  return new HttpError(409, 'DAILY_LIMIT_EXCEEDED', 'Daily withdrawal limit of INR 2,000 exceeded');
}

function replay(res, payout, amount) {
  if (payout.amountPaise !== amount || payout.currency !== 'INR') {
    throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key reused for a different request');
  }
  return res.status(200).json({ payoutId: payout._id, status: payout.status });
}

async function withdraw(req, res, next, receivedAt = Date.now()) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.user?.id)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Valid authentication required');
    }
    const userId = new mongoose.Types.ObjectId(req.user.id);
    const amount = req.body?.amountPaise;
    const key = req.get('Idempotency-Key');
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new HttpError(400, 'INVALID_AMOUNT', 'amountPaise must be a positive safe integer');
    }
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
      throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 letters, digits, underscores or hyphens');
    }
    const filter = { userId, idempotencyKey: key };
    const existing = await Payout.findOne(filter).lean();
    if (existing) return replay(res, existing, amount);
    if (amount > dailyLimitPaise) throw dailyLimitError();

    const day = istDay.format(receivedAt);
    const payoutId = new mongoose.Types.ObjectId();
    try {
      await mongoose.connection.transaction(async session => {
        const user = await User.findById(userId).session(session).lean();
        if (!user?.bankVerified || !user.payoutEligible || !user.bankToken) {
          throw new HttpError(403, 'INELIGIBLE', 'Payout account not eligible');
        }
        // Unique insertion reserves this user's key; all writes commit or abort together.
        await Payout.create([{
          _id: payoutId, ...filter, amountPaise: amount, currency: 'INR',
          bankToken: user.bankToken, status: 'pending', gatewayReference: `WD-${payoutId}`
        }], { session });
        const wallet = await Wallet.findOneAndUpdate({
          userId, currency: 'INR', availablePaise: { $gte: amount }
        }, { $inc: { availablePaise: -amount } }, { new: true, session });
        if (!wallet) {
          throw new HttpError(409, 'INSUFFICIENT_BALANCE', 'Insufficient available balance or missing wallet');
        }
        // Same-user requests reach the counter only after writing the same wallet.
        const usage = await DailyWithdrawal.findOneAndUpdate(
          { userId, day }, { $inc: { usedPaise: amount } }, { upsert: true, new: true, session }
        );
        if (usage.usedPaise > dailyLimitPaise) throw dailyLimitError();

        await Ledger.create([{
          eventId: `reserve:${payoutId}`, userId, payoutId, type: 'withdrawal_reserved',
          deltaPaise: -amount, balanceAfterPaise: wallet.availablePaise
        }], { session });
        await Outbox.create([{
          eventId: `send:${payoutId}`, payoutId, type: 'send_payout', state: 'pending'
        }], { session });
      }, transactionOptions);
    } catch (err) {
      if (err.code === 11000) {
        const duplicate = await Payout.findOne(filter).lean();
        if (duplicate) return replay(res, duplicate, amount);
        throw new HttpError(503, 'RETRY_SAME_KEY', 'Request unresolved; retry with the same key');
      }
      throw err;
    }
    return res.status(202).json({ payoutId, status: 'pending' });
  } catch (err) { next(err); }
}

function createApp(authOptions, { now = Date.now } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.post('/api/wallet/withdraw', authenticate(authOptions), (req, res, next) => {
    return withdraw(req, res, next, now());
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use((err, req, res, _next) => {
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    const code = status === 500 ? 'INTERNAL_ERROR' : (err.code || 'INVALID_REQUEST');
    const message = status === 500 ? 'Request unresolved; retry with the same key'
      : err.type === 'entity.parse.failed' ? 'Invalid JSON body'
        : err.type === 'entity.too.large' ? 'Request body too large' : err.message;
    log('request_failed', { requestId: req.requestId, status, code });
    res.status(status).json({
      error: { code, message },
      requestId: req.requestId
    });
  });
  return app;
}

async function start() {
  const app = createApp({ secret: process.env.JWT_SECRET });
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  await mongoose.connect(uri);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB must support transactions');
  await createIndexes();
  const server = app.listen(port, '127.0.0.1', () => console.log(`Listening on http://127.0.0.1:${port}`));
  server.once('error', startupFailed);
}

async function startupFailed() {
  console.error('Could not start. Check the environment, MongoDB replica set and port.');
  process.exitCode = 1;
  await mongoose.disconnect();
}

if (require.main === module) start().catch(startupFailed);

module.exports = {
  withdraw, createApp, createIndexes, transactionOptions,
  User, Wallet, DailyWithdrawal, Payout, Ledger, Outbox
};
