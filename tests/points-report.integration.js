const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MongoClient, ObjectId, Long } = require('mongoose').mongo;
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { monthlyPointsPipeline, monthlyCohortPipeline } = require('../src/points-report');

let replica;
let client;
let events;
const start = new Date('2026-10-01T00:00:00.000Z');
const end = new Date('2026-11-01T00:00:00.000Z');
const options = { start, end };
const userA = new ObjectId();
const userB = new ObjectId();
const userC = new ObjectId();

function event(userId, cohortId, type, points, occurredAt = start) {
  return { eventId: randomUUID(), userId, cohortId, type, points, occurredAt };
}
function strings(row) {
  return {
    ...row,
    pointsEarned: row.pointsEarned.toString(),
    pointsConverted: row.pointsConverted.toString(),
    pointsExpired: row.pointsExpired.toString()
  };
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({
    binary: { downloadDir: path.resolve('.cache/mongodb-binaries') },
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  client = await new MongoClient(replica.getUri()).connect();
});
beforeEach(() => {
  events = client.db(`funngro_points_test_${randomUUID().replaceAll('-', '')}`).collection('point_events');
});
afterAll(async () => {
  if (client) await client.close();
  if (replica) await replica.stop();
});

test('monthly per-user report respects UTC boundaries, cohort and allocation events', async () => {
  await events.insertMany([
    event(userA, 'cohort-a', 'earned', 100),
    event(userA, 'cohort-a', 'converted', 20),
    event(userA, 'cohort-a', 'converted', 30), // two lot allocations, total conversion = 50
    event(userA, 'cohort-a', 'expired', 10, new Date(+end - 1)),
    event(userB, 'cohort-a', 'earned', 200),
    event(userC, 'cohort-b', 'expired', 7),
    event(userA, 'cohort-a', 'earned', 999, new Date(+start - 1)),
    event(userA, 'cohort-a', 'converted', 999, end)
  ]);
  const rows = (await events.aggregate(monthlyPointsPipeline(options)).toArray()).map(strings);
  expect(rows).toHaveLength(3);
  expect(rows.find(row => row.userId.equals(userA))).toMatchObject({
    cohortId: 'cohort-a', pointsEarned: '100', pointsConverted: '50', pointsExpired: '10'
  });
  expect(rows.find(row => row.userId.equals(userB))).toMatchObject({
    pointsEarned: '200', pointsConverted: '0', pointsExpired: '0'
  });
  expect(rows.find(row => row.userId.equals(userC))).toMatchObject({
    cohortId: 'cohort-b', pointsEarned: '0', pointsConverted: '0', pointsExpired: '7'
  });
});

test('optional cohort filter and cohort totals exclude other cohorts and count active users', async () => {
  await events.insertMany([
    event(userA, 'cohort-a', 'earned', 100),
    event(userA, 'cohort-a', 'converted', 40),
    event(userB, 'cohort-a', 'expired', 20),
    event(userC, 'cohort-b', 'earned', 999)
  ]);
  const filtered = { ...options, cohortId: 'cohort-a' };
  expect(await events.aggregate(monthlyPointsPipeline(filtered)).toArray()).toHaveLength(2);
  const rows = (await events.aggregate(monthlyCohortPipeline(filtered)).toArray()).map(strings);
  expect(rows).toEqual([{
    cohortId: 'cohort-a', activeUsers: 2,
    pointsEarned: '100', pointsConverted: '40', pointsExpired: '20'
  }]);
});

test('finance sums remain exact beyond JavaScript safe-integer totals', async () => {
  const large = Long.fromString('9007199254740991');
  await events.insertMany([
    event(userA, 'cohort-a', 'earned', large),
    event(userA, 'cohort-a', 'earned', large)
  ]);
  const [row] = await events.aggregate(monthlyPointsPipeline(options)).toArray();
  expect(row.pointsEarned.toString()).toBe('18014398509481982');
});

test('empty month has no rows; delayed expiry is attributed to its effective month', async () => {
  expect(await events.aggregate(monthlyPointsPipeline(options)).toArray()).toEqual([]);
  await events.insertOne({
    ...event(userA, 'cohort-a', 'expired', 25, new Date(+end - 1)),
    recordedAt: new Date('2026-11-03T00:00:00.000Z')
  });
  const [row] = await events.aggregate(monthlyPointsPipeline(options)).toArray();
  expect(row.pointsExpired.toString()).toBe('25');
});

test('report rejects invalid boundaries and non-string cohort filters', () => {
  for (const invalid of [
    undefined, { start: '2026-10-01', end }, { start: end, end: start },
    { start: new Date('invalid'), end }, { ...options, cohortId: { $ne: null } }
  ]) expect(() => monthlyPointsPipeline(invalid)).toThrow();
});
