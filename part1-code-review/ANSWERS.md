# Part 1 — Payouts

| Rank | Issue and example | Fix |
| --- | --- | --- |
| 1 | **Duplicate payouts.** The gateway accepts a transfer, the response times out, and the mobile retry debits and pays again. | Require a user-scoped request key and a stable provider reference with gateway deduplication. |
| 2 | **Balance race.** Two ₹800 requests read ₹1,000 and each writes ₹200. The gateway pays ₹1,600 while the wallet reflects one debit. | Check available funds in the same atomic update that decrements the balance. |
| 3 | **Invalid amount or units.** A negative amount increases the balance. A rupees-to-paise mismatch can send the wrong amount. | Accept positive safe integers in paise and map currency and units explicitly. |
| 4 | **False success.** The gateway promise rejects after the handler reports success. The catch misses the rejection, which can terminate the Node process. The debit is left in place. | Await the gateway in a worker and return acceptance after reservation. |
| 5 | **Missing ownership check.** An authenticated caller can supply someone else’s `userId` and trigger a transfer to that user’s stored bank account. Passing an object as the ID also risks NoSQL injection if it reaches the query as a filter. | Derive wallet ownership from authenticated identity. |
| 6 | **Partial writes.** A process crash after the debit leaves funds missing and no durable payout job. | Commit the debit, payout, ledger entry and outbox job in one transaction. |
| 7 | **Ambiguous outcomes.** A gateway timeout after acceptance can leave a debit unresolved or lead to a refund after money has been sent. | Keep funds reserved and reconcile the original transfer before settling. |
| 8 | **Timestamp references.** Two transfers created in the same millisecond share a reference, making reconciliation ambiguous. | Derive the reference from the unique payout ID. |
| 9 | **Missing eligibility checks.** A user without verified bank details or required guardian approval can start a payout. | Check upstream eligibility and snapshot the verified bank token. |
| 10 | **Unindexed, unbounded reads.** A wallet lookup can scan 2M records. A ledger read can scan 40M, block on a sort and return a large history, causing retries. | Index wallet ownership and ledger history. Paginate history on a separate route. |
| 11 | **Missing wallet.** A user whose wallet was never created triggers a null read and gets a server error. | Check for the wallet and return a controlled error. |
| 12 | **Raw provider logs.** A rejected payout can leave bank details in an error log. | Log the payout ID and an approved error code. |
| 13 | **No admission controls.** A burst from one valid account can consume worker capacity. | Agree on amount and daily limits, rate-limit requests and cap body size. |

## Rewrite

See [the withdrawal route, transaction and indexes](../src/withdraw.js) and [the payout processor](../src/payouts.js).

The shared handler includes the [Round 2 daily limit](../round-2/DAILY-LIMIT.md).

`POST /api/wallet/withdraw` takes a bearer JWT, a positive safe integer `amountPaise` in INR and an `Idempotency-Key` of 8–128 letters, digits, underscores or hyphens. The JWT supplies the user ID. The stored bank token and eligibility flags are checked at reservation.

- **202** returns a new `payoutId` with status `pending`. **200** returns the existing ID and current status on a matching replay.
- **400** means invalid input, **401** invalid authentication, **403** ineligible account and **409** insufficient funds, missing wallet, conflicting key reuse or an exceeded daily limit.
- After a timeout or unresolved **5xx**, reuse the **same key and amount**. Retain keys for the supported retry window.

### Worker and gateway

`processPayout` takes a claimed job and a gateway adapter. After an uncertain attempt it looks up the original `WD-<payoutId>`. It resends only on `not_found` when `canResubmit(reference)` explicitly guarantees deduplication through provider acceptance, including overlapping and delayed sends. The adapter supplies bounded transport calls and normalizes outcomes for that reference.

An unclear result keeps funds reserved. Settlement requires `{ status: "failed", definitive: true }` to refund and checks the lease token in the refund transaction. On success, the reservation remains the debit and the payout records the final status and provider ID when available.

```text
Scheduling pseudocode: poll with bounded concurrency, claimJob(), then processPayout(job, adapter).
Escalate unresolved references for reconciliation.
```

## Architecture

Roll this out to clients that can reuse the same request key. Check the units in the old balance field and reconcile the balances before switching reads. Build indexes in stages and watch disk load and replication lag. In production, space out retries and alert an operator when a payout stays unresolved.

## Questions for the founder

1. How long does the gateway deduplicate a reference, and which failure statuses are final?
2. What fees, limits and eligibility rules should the API apply? What should happen if eligibility changes after funds are reserved?
3. How long can clients retry, and what payout information do they need in the app?
