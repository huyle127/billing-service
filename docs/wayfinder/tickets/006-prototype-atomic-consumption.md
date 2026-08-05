# 006 Prototype atomic two-ledger consumption

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:prototype -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

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

**Yes, and the concern that created this ticket is closed.** Prisma expresses atomic two-ledger
consumption on Neon safely, provided Serializable isolation is not the mechanism.

Three strategies were implemented and raced: 30 concurrent callers, 10 credits each, against a
wallet holding 150 (100 subscription + 50 add-on). Exactly 15 should succeed.

| Strategy | Succeeded | Declined | Errored | Final balance |
| --- | --- | --- | --- | --- |
| A — `Serializable` isolation, read then write | **10 / 15** | 0 | **20** | 50 left unspent |
| B — `SELECT … FOR UPDATE` in an interactive transaction | 15 / 15 | 15 | 0 | 0 |
| C — single conditional `UPDATE … WHERE balance >= n` | 15 / 15 | 15 | 0 | 0 |

**Serializable is rejected.** It did not oversell — no correctness failure — but 20 of 30 requests
errored outright despite eight retries with jittered backoff, and **five legitimate consumptions
were lost**. Thirty transactions contending for one row conflict combinatorially. A contributing
factor is that Prisma's error surface does not make serialization failures reliably
distinguishable, so retry logic cannot be written with confidence — which is itself an argument
against the approach.

**B and C are both correct**, at effectively identical cost (2526ms versus 2497ms, within noise).
All three strategies handled draw order (100 from subscription, 20 from add-on when consuming 120)
and the frozen wallet correctly.

**Recommendation: B, `SELECT … FOR UPDATE`.** C is equally safe and marginally fewer round trips,
but it pushes the draw-order arithmetic into a SQL `LEAST` expression where it cannot be unit
tested, and on decline it needs a second query to distinguish `BILLING_FROZEN` from
`INSUFFICIENT_CREDITS`. B reads the balance before deciding, so the split across ledgers is computed
in application code — which the API contract needs anyway, since it returns
`consumed: { subscription, addon }`.

The original worry about Prisma losing type safety at the ledger is real but narrow: only the lock
statement drops to `$queryRaw`. The decision, the arithmetic, and the transaction write stay typed.

### Design defect this spike exposed

Requirements state each Credit Transaction is tied to **one** ledger. A consumption spanning both
must therefore write **two** rows — but `idempotencyKey` was `@unique` globally, so two rows from a
single logical consumption could not share a key. The schema forced a choice between violating the
requirement and breaking idempotency.

Fixed: the constraint is now composite, `@@unique([idempotencyKey, ledger])`, applied in migration
`..._credit_tx_idempotency_per_ledger`. Verified by attempting to violate it — the same key across
two different ledgers is accepted, a retry of either leg is rejected, and NULL keys remain mutually
distinct. A single consumption of 120 now correctly produces `SUBSCRIPTION -100` and `ADDON -20`
sharing one key.

### Note

`prisma migrate dev` cannot run non-interactively when it emits a warning. Migrations of that kind
must be produced with `prisma migrate diff --from-config-datasource --to-schema` and applied with
`prisma migrate deploy`. Recorded because it will recur.
