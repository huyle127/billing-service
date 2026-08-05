# 033 Build billing history

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 021, 025, 027 -->

## Question

`GET /v1/me/history` and the history portion of `GET /v1/admin/users/:userId/billing`.

**Materialization — settled 2026-08-05: computed on read. No materialized view.**

The three source tables are already indexed for exactly this read — `PaymentTransaction` on
`(userId, occurredAt)`, `CreditTransaction` on `(walletId, createdAt)`, `SubscriptionEvent` on
`(subscriptionId, occurredAt)`. The query is per-user and page-bounded, so the merge touches tens of
rows, not the table.

The deciding argument is the one this codebase already made against the outbox pattern in
[`stripe-sync.md`](../../architecture/stripe-sync.md) §2: a materialized view needs a refresh
strategy, and a refresh strategy is a **second source of truth that can disagree with the first**.
History is fully derivable from the ledgers, and where work is derivable, a second store is strictly
worse. Revisit only if a page read is measured to be slow — not before.

**The real difficulty is the cursor, not the merge.** Two rows in different source tables can carry
the same timestamp, so a cursor encoding time alone is not a total order and will skip or repeat rows
at a page boundary. Encode `(timestamp, source, id)` and sort on all three.

- Aggregated from `PaymentTransaction`, `CreditTransaction`, and `SubscriptionEvent`. It **does not
  duplicate** events from the source ledgers — history is a view over them, and nothing writes to it.
- **One endpoint with filters, not three.** The requirements define history as a single derived view;
  splitting it per source would push the merging work onto every client.
- **Cursor pagination, not offset.** History grows indefinitely and new rows arrive at the head, so
  offset pagination would skip or repeat entries as a user pages through. The cursor encodes the sort
  position of the last row returned.
- Filters: `type`, `from`, `limit`, `cursor`, as in
  [`api-surface.md`](../../architecture/api-surface.md).
- Read-only. Assert that a merged page is stable across insertion at the head — that is the bug
  offset pagination would have.

**Coverage gap to fix as part of this ticket.**
[`requirement-coverage.md`](../../testing/requirement-coverage.md) has **no Section 8 table**, so
nothing currently tracks billing history at all. Add it, then satisfy it.
