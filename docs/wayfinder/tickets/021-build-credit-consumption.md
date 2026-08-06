# 021 Build the credit ledger: consumption and reversal

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-06) -->
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

## Answer

Shipped through OpenSpec change `build-credit-consumption`. **All eight clauses closed**, across 32
new tests. `FOR UPDATE` behaved exactly as ticket 006 measured: thirty callers, fifteen successes,
fifteen declines, both balances on zero, nothing errored. No schema change and no migration — the
tables, both unique constraints and the non-negative `CHECK`s were already in place.

**The published response shape was wrong and was replaced.** `api-surface.md` returned one
`transactionId` for an operation that writes one row per ledger, so it could only ever name one of
the two rows a spanning consumption produces. The response now carries
`transactions: [{ id, ledger, amount }]`. This was affordable only because no application has
integrated yet — the same widening after one has costs a `/v2`, which is what the version prefix is
for. A decline omits the field rather than sending an empty array, and the reversal response carries
no `success` flag, because a reversal has no outcome to decline.

**Three orderings had to be settled, and only one was in the ticket.**

- **Replay outranks the freeze.** A consumption succeeds, the subscription goes past due, the wallet
  freezes, and the caller — who timed out and never saw the first response — retries. Answering
  `BILLING_FROZEN` tells a caller whose credits are already spent that they are still there, so it
  abandons or re-charges work it has paid for. Inside the lock the order is: missing wallet, replay,
  key reuse, freeze, sufficiency.
- **A second reversal replays rather than failing.** "Reversed at most once" is about rows written,
  which `reversesId @unique` holds; a repeated *request* is a retry and gets the first reversal's
  result.
- **Reversal rows carry no idempotency key.** Copying the consumption's key collides with the
  consumption's own row on `@@unique([idempotencyKey, ledger])` and the reversal becomes unwritable.

**A replay reports the balance of an untouched ledger as it now stands**, not as it was: a
consumption that drew only from subscription wrote no add-on row, so no snapshot of that instant
exists. Reconstructing one means a snapshot column pair on a money table. Stated as a scenario rather
than left as a surprise.

**Two findings that outlive this ticket:**

- **The global guard belongs in `auth.module.ts`, not the composition root.** Registered at the root
  it reaches only graphs rooted at `AppModule`, so `test/auth-http.spec.ts` — which composes modules
  directly — silently lost logout's guard and returned a `500` where a `401` belonged. Registered in
  the module that owns it, a graph containing `auth` is authenticated by definition.
  `common/identity/` now publishes the identity contract — `AuthenticatedUser`, `@CurrentUser()`,
  `@Public()` — so `credit` reads a verified caller without an import that would close
  `auth ──▶ billing ──▶ credit ──▶ auth`. Ticket 024's webhook route needs `@Public()` from
  `billing/` for the same reason.
- **Prisma's 2s default `maxWait` breaks the concurrency requirement.** Thirty callers queue behind
  the connection pool and the row lock, and those at the back were rejected with
  `Unable to start a transaction in the given time` — a server error where the spec says a caller is
  declined and never errored. `maxWait` and `timeout` are now named in `credit.constants.ts`. The
  `pg` pool still defaults to ten connections, which caps how many run at once; worth revisiting when
  the service is under real load.
