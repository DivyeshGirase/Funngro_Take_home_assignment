# Part 3 — First 30 minutes

## 21:00–21:05 — Stop new debits

Ask the on-call owner to pause withdrawals before the wallet debit. If retrying a payout could create a second transfer, pause gateway sends too. Keep status checks and callbacks running. Confirm that new debits have stopped. Ask Support to collect request IDs, tell users to hold off on retries, and give an update at 21:10.

## 21:05–21:12 — Check the database and the gateway

I would check the ledger query first. It reads a user's history and sorts by time on a collection of about 40 million records. In Atlas Query Profiler, find an existing slow sample for that query. Compare documents examined with documents returned, and check for a collection scan or a blocking sort. In Atlas Metrics, compare CPU, disk read latency, connections and replication lag with the normal period when request p95 was 300 ms. [Atlas Query Profiler](https://www.mongodb.com/docs/atlas/tutorial/query-profiler/) · [Atlas Metrics](https://www.mongodb.com/docs/atlas/review-available-metrics/)

In a read-only mongosh session on the production database, check the existing indexes. Use the collection name from the profiler sample. The Mongoose model here uses the name shown below.

```javascript
db.getCollection("ledgers").getIndexes()
```

Ask the gateway owner to check the available payout balance against the amount queued for payment. Check for insufficient-funds errors, rate limits and changes in gateway response time during the incident.

## 21:12–21:23 — Check where the money went

Match each affected debit to its original gateway reference. If the gateway confirms payment, record the success. If it confirms a final failure, verify the original debit and check for a prior refund before crediting the wallet. If the gateway result is unclear, leave the debit in place and keep checking the original reference.

If the ledger query explains the slowdown, remove the history read from the withdrawal path. I would defer building the index during peak load. Schedule the build after traffic drops and check free disk space and replication lag before starting.

## 21:23–21:30 — Decide whether to reopen

Keep withdrawals paused if the gateway balance is too low or new requests could still create duplicate payouts. Once the cause is addressed, reopen at a low rate. Watch request p95, gateway errors and the count of payouts with an unknown result. Pause again if any of those rise sharply. Tell Support what is confirmed, what is still being checked and when the next update will come.
