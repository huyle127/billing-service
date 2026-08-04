# 006 Prototype atomic two-ledger consumption

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:prototype -->
<!-- mode: HITL -->
<!-- status: open -->
<!-- assignee: -->
<!-- blocked-by: 001 -->

## Question

Can atomic credit consumption across two ledgers be expressed safely in Prisma against Neon, and
what does that code look like?

This ticket exists because of a concern raised while charting: Prisma's ergonomics are weakest
exactly where this system is most dangerous — row locking and conditional decrements on a money
ledger. Rather than argue it, spike it.

What the prototype must demonstrate:

- Draw the requested amount from Subscription Credits first, then Add-on Credits, in one
  transaction, with no partial deduction on failure (requirements §6).
- Enforce a non-negative balance under **concurrent** consume calls for the same wallet. Two
  simultaneous requests must not oversell. Test this with real concurrency, not sequentially.
- Return the specified failure reasons: `INSUFFICIENT_CREDITS`, `BILLING_FROZEN`.
- Write the corresponding `CreditTransaction` rows inside the same transaction.

Approaches to compare:

- `prisma.$transaction` with a raised isolation level (Serializable), and what retry-on-conflict
  costs.
- `SELECT ... FOR UPDATE` via `$queryRaw` inside an interactive transaction, and how much type
  safety is lost.
- A conditional `UPDATE ... WHERE balance >= n` returning affected-row count.

**Neon-specific risk to settle here:** the `@neondatabase/serverless` HTTP driver does not support
interactive transactions. Verify which connection path (pooled TCP, WebSocket driver, or direct)
actually supports the chosen approach, and whether PgBouncer transaction pooling interferes with
locking. `AGENTS.md` requires transactions for state-changing operations, so this is not optional.

If the spike shows the approach is clean, close cheaply. If it does not, the finding reshapes 007.

## Answer

_Unresolved._
