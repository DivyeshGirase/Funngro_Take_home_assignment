# Funngro Backend Assessment

Node.js and MongoDB submission covering the Round 1 take-home and the Round 2 withdrawal extension.

## Round 1

| Part | Submission |
| --- | --- |
| 1. Code review and payouts | [Review and payout design](part1-code-review/ANSWERS.md), [withdrawal handler](src/withdraw.js), [payout processor](src/payouts.js) |
| 2. Reward points | [Schema and indexes](part2-schema-design/ANSWERS.md), [monthly report](src/points-report.js) |
| 3. Incident response | [First 30 minutes](part3-incident-response/ANSWERS.md) |

## Round 2

- [Daily withdrawal limit](round-2/DAILY-LIMIT.md) explains how the ₹2,000 IST cap works when multiple requests arrive together.
- [Wallet notifications](NOTIFICATION.md) explains how to notify users after a committed balance change and handle failed or repeated deliveries.

## How to run

Use Node.js 20.19 or newer.

```sh
npm ci
npm test
```

The tests start a disposable MongoDB replica set. The first run may download MongoDB. Set `MONGOMS_SYSTEM_BINARY` to use an existing compatible binary.

All 24 tests passed against MongoDB 7.0.24.

To run the API, copy `.env.example` to `.env`, set a development MongoDB replica set URI and a JWT secret of at least 32 bytes, then run `node --env-file=.env src/withdraw.js`. Startup creates the indexes.

Send `POST /api/wallet/withdraw` with a bearer JWT, an `Idempotency-Key` header and a JSON body such as `{"amountPaise": 10000}`. The token needs the eligible user's MongoDB ID as its subject, an expiry, issuer `funngro-assessment` and audience `funngro-api`. The user needs a verified bank token and a funded INR wallet. Local startup queues payouts. The tests exercise settlement with a fake gateway.

AI assistance was used for implementation, tests and documentation.
