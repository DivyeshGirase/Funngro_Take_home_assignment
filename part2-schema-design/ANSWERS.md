# Part 2 — Reward points

Use whole points, one INR rate, UTC months and a fixed signup cohort copied to each lot and event. `Int` means a BSON integer within JavaScript’s safe range.

```text
reward_lots {
  _id: ObjectId, userId: ObjectId, cohortId: String,
  sourceType: "project" | "promotion", sourceId: String,
  grantedPoints: Int, remainingPoints: Int, earnedAt: Date, expiresAt: Date
}
point_rates {
  _id: ObjectId, currency: "INR", effectiveFrom: Date,
  paiseNumerator: Int, pointsDenominator: Int
}
point_conversions {
  _id: ObjectId, userId: ObjectId, idempotencyKey: String, points: Int,
  currency: "INR", rateId: ObjectId,
  rateSnapshot: { paiseNumerator: Int, pointsDenominator: Int, rounding: "floor" },
  cashPaise: Int, allocations: [{ lotId: ObjectId, points: Int }],
  walletCreditEventId: String, createdAt: Date
}
point_events {
  _id: ObjectId, eventId: String, userId: ObjectId, cohortId: String,
  lotId: ObjectId, conversionId?: ObjectId,
  type: "earned" | "converted" | "expired", points: Int,
  occurredAt: Date, recordedAt: Date
}
```

| Index | Query |
| --- | --- |
| Lots, unique `{ userId: 1, sourceType: 1, sourceId: 1 }` | Find an existing grant on award retry. |
| Lots, `{ userId: 1, expiresAt: 1, _id: 1 }` | Find unexpired lots for one user, earliest expiry first. |
| Lots, `{ expiresAt: 1, _id: 1 }` | Scan due lots in batches. Both expiry indexes and queries filter on `remainingPoints > 0`. |
| Rates, unique `{ currency: 1, effectiveFrom: -1 }` | Find the latest rate effective at conversion time. |
| Conversions, unique `{ userId: 1, idempotencyKey: 1 }` | Find and compare the original request on retry. |
| Events, unique `{ eventId: 1 }` | Prevent duplicate grant, expiry and per-lot conversion events. |
| Events, `{ occurredAt: 1 }` and `{ cohortId: 1, occurredAt: 1 }` | Match the month across all cohorts or within one cohort. |

Create the lot and earned event together. On expiry, conditionally zero the remainder and record it in one transaction. Keep expired lots and old rates for audit.

## Monthly report

[The executable pipelines](../src/points-report.js) sum earned, converted and expired points per user and cohort using Decimal128. Match the half-open UTC month by `occurredAt`. Count each conversion allocation once and use scheduled expiry as the expiry event’s effective time. Confirm timezone, cohort definition and late adjustments with Finance.

## Double conversion

In one transaction, insert the user-scoped conversion and rate snapshot, then deduct from unexpired lots only where enough points remain. Require the deductions to cover the full request. Floor the cash result once using integer arithmetic, reject zero or overflow, append the point events, credit the wallet and write a unique `points-credit:<conversionId>` entry to the same ledger as payouts. Extend that ledger with a `points_conversion` type and a required `conversionId` for credits. Concurrent deductions from the same lot conflict, so a retry reads fresh balances and either completes or aborts without a credit. Replay the original conversion for a matching key and amount. Cap lots per request to bound transaction time and reject oversized conversions in full.
