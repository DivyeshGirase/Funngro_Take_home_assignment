# Round 2 — Daily Withdrawal Limit

## Changes from Round 1

I added a daily usage record for each user and IST date. Its unique index is on `userId` and `day`. The counter update is in the same transaction as the payout, wallet debit, ledger and outbox writes.

## Daily Withdrawal Limit

Each user can reserve up to ₹2,000 (200000 paise) per calendar day. The API takes the date in `Asia/Kolkata` when the authenticated request enters the handler. MongoDB retries use the same date. A request received from midnight IST uses a new counter.

The payout key is checked before applying the cap. Reusing the key and amount returns the existing payout, including after midnight. A different amount with the same key returns a conflict.

## Handling Concurrent Requests

MongoDB detects a write conflict when requests for the same user try to debit the same wallet. The driver retries transient conflicts in a fresh transaction. After the debit, an atomic increment creates or updates the daily counter. If the result exceeds the limit, the transaction aborts and rolls back all its writes.

For example, if a user with ₹5,000 available requests ₹1,500 and ₹1,000 at the same time with an unused daily limit, only one request can commit. The other returns `409 DAILY_LIMIT_EXCEEDED`.

## Assumptions

A committed reservation counts against the day it was accepted. Pending, processing, unknown and successful payouts all count. A definitive payout failure restores the wallet balance, but the original reservation still counts for that day. A rejected or rolled-back reservation uses no quota.

For an existing database, create the indexes and switch over at midnight IST after pausing and draining old withdrawal requests. Avoid running both versions against the same wallet. For a mid-day switch, pause withdrawals and seed each user's counter from that IST day's committed withdrawal reservations, including refunded ones, before enabling the route. Keep existing payout records so their keys can still be replayed.
