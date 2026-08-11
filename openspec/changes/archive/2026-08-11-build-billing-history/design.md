## Context

Ticket 033 settled materialization on 2026-08-05 — computed on read, no view — and named the cursor
as the real difficulty. What it did not settle is that the merge crosses a module boundary:
`module-boundaries.md` gives `CreditTransaction` to `credit`, and `credit` is a leaf.

## Goals / Non-Goals

**Goals:** one merged page over three ledgers with a total order that survives ties and head
insertion, without billing reading a table it does not own.

**Non-Goals:** a materialized view, a refresh strategy, a `to` bound, ascending order, and any write
path. Revisit materialization only when a page read is measured slow — ticket 033.

## Decisions

**The merge is three queries in application code, not one `UNION ALL`.** A single SQL union is the
cheaper query and is unavailable: billing would have to name `"CreditTransaction"`, which belongs to
`credit`, and the module graph has no edge letting it. So `HistoryService` asks each owner for one
page — `CreditService` for its rows, billing's own repositories for the other two — and merges.
Each source is asked for `limit + 1` rows below the cursor, which is the fewest that can answer,
because any one source may supply the whole page. The page touches at most `3 × (limit + 1)` rows,
which is the order of magnitude ticket 033 already accepted.

**`CreditService` gains `history(userId, window)`.** It is the same shape as `balances(userId)`,
which `AdminBillingViewService` already calls: billing states what it needs, `credit` decides how to
read its own table. The `(walletId, createdAt)` index serves it as it stands.

**The cursor is base64 of `occurredAt|source|id`, and every source query filters on all three.**
Time alone is not a total order across three tables, and `(time, id)` is not either — ids are uuids,
so ordering by id across sources is arbitrary but stable, which is all the tiebreak needs; `source`
sits between them so a single source's own slice stays a plain two-column predicate against its
index. Encoding it opaquely keeps the sort key a private detail, so adding a fourth ledger later
does not break a client that stored a cursor. A cursor is positional, not temporal: it is applied as
`(occurredAt, source, id) < cursor` rather than as a time bound, which is exactly why a row written
at the head after the first page cannot shift the second.

**`CreditTransaction.createdAt` is the merge's `occurredAt`.** The other two tables name the column
`occurredAt`; the credit ledger does not, and renaming it is a migration this read-only change has no
reason to run. The mapping happens where the row is projected.

**The admin route embeds the page rather than gaining a sibling route.** `api-surface.md` says this
route answers with "Subscription, wallet, and history for one user", and a second route would restate
the whole filter contract for one extra caller. It takes `cursor` only — not `type` or `from` — since
an admin looking at one user wants the recent trail, and the full filter set has a caller only on
`/v1/me/history`.

**Payments appear at every status.** Ticket 032 writes a `PaymentTransaction` `PENDING` before Stripe
is called and leaves it `PENDING` through `requires_action`, which is a resting state, not a
transient one. Hiding non-settled rows would make a user's own pending purchase invisible and leave a
`PAST_DUE` subscription with nothing in history explaining it.

**No schema change and no migration.** Every column the view reads exists, and the three indexes
ticket 007 wrote — `(userId, occurredAt)`, `(walletId, createdAt)`, `(subscriptionId, occurredAt)` —
are the ones this query needs.

## Risks / Trade-offs

The subscription-event slice needs the caller's subscription ids first, so that source costs a lookup
the other two do not; the ids are few and already indexed by `userId`.

Over-fetching `limit + 1` per source means a page of 50 can read 153 rows to return 50. That is the
price of not unioning in SQL, and it is bounded by `limit`, not by history length.
