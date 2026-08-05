# 021 Build the credit ledger: consumption and reversal

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/credit/ -->
<!-- blocked-by: 018, 020 -->

## Question

The hot path — the endpoint other applications call, and the one place in this service where money
and concurrency meet.

**Use `/tdd`.** The map names the credit ledger as one of the two areas built test-first.

- `POST /v1/credits/consume` and `POST /v1/credits/reverse`, shaped as in
  [`api-surface.md`](../../architecture/api-surface.md).
- **`SELECT … FOR UPDATE` on the single `CreditWallet` row**, compute the split across ledgers, then
  write. Ticket 006 raced three strategies at thirty concurrent callers: `FOR UPDATE` wins, a single
  conditional `UPDATE` ties it, and **Serializable is rejected** — it lost twenty of thirty requests
  to serialization conflicts retry could not recover, with no compensating safety gain.
- Subscription credits are drawn first, then add-on credits.
- **One `CreditTransaction` row per ledger**, sharing the caller's key. This is why the constraint is
  `@@unique([idempotencyKey, ledger])` and not on the key alone — ticket 006 found the key-only
  version made a two-ledger consumption impossible to write, and the fix is already migrated.
- **The caller supplies the idempotency key and it is required.** Credits are deducted *before* the
  caller does its work, so a retry after a timeout must charge once. The guarantee comes from the
  unique constraint, not from application logic, so it survives concurrent retries.
- **What a replay returns — settled 2026-08-05, and it is a public contract.** `api-surface.md`
  defined the first call and said nothing about the second, which would have left the unique
  constraint surfacing as a 500.
  - Same key, same amount → **`200` with the original result**: the first call's `transactionId` and
    the balances as they were then. A retry after a timeout must look like the success it replays.
  - Same key, **different amount** → **`400` with `IDEMPOTENCY_KEY_REUSED`**. This is a caller bug —
    one key now means two different operations — and it is worth failing loudly, because silently
    returning the first result would undercharge without anyone noticing. This matches what Stripe
    and Square do, so integrating applications already expect it.
- Reversal writes a `REVERSAL` transaction linked through `reversesId`, which is `@unique` — **a
  consumption can be reversed at most once, enforced by the constraint**, never by a check-then-write.
  Credits return to the ledger they were drawn from. Reversal exists because `adjustment` is
  admin-only and add-on-only, which left no legitimate way to return subscription credits after a
  failed operation.
- **Declines return 200** with `success: false` and a reason — `INSUFFICIENT_CREDITS` and
  `BILLING_FROZEN` reported distinctly. They are business outcomes, not server errors.
- **Every decline emits a counter labelled by reason**, through the metrics seam from 018.
- **`credit` is a leaf module.** It never reads `billing`, `user`, or `auth`. The caller passes the
  amount and an opaque key; the ledger does not interpret the key and knows nothing about
  subscriptions. If it ever needs to look up a subscription to decide an amount, the dependency cycle
  is back.

Concurrency test pattern, already proven in ticket 006: fire N callers at a wallet holding fewer
credits than they collectively request, then assert exactly `floor(balance / amount)` succeed, the
balance lands on its floor, and the transaction count matches the successes. Real parallel
connections, asserting on outcome and never on timing.

Note the harness constraint from ticket 010: transaction-rollback-per-test does not work here,
because consumption opens its own transaction and a test-owned outer one would nest. The suite
truncates instead.

## Requirement clauses closed

Section 6:

- Consumption is atomic — no partial deduction
- Subscription credits are drawn before add-on credits
- Concurrent consumption cannot oversell
- Consumption is idempotent on the caller's key
- Reversal restores credits to the ledger they came from
- A consumption can be reversed at most once
- Declines report `INSUFFICIENT_CREDITS` and `BILLING_FROZEN` distinctly
- A decline emits a metric
