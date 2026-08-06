## Why

Implements wayfinder ticket [021 Build the credit ledger: consumption and reversal](../../../docs/wayfinder/tickets/021-build-credit-consumption.md),
unblocked by changes `build-common-layer` (018) and `build-auth-module` (020). The mechanism was
raced and chosen in [006](../../../docs/wayfinder/tickets/006-prototype-atomic-consumption.md).

This is the hot path — the endpoint other applications call, and the one place in this service where
money and concurrency meet. Nothing consumes credits today: the wallet and the two ledgers exist as
tables with constraints on them, and no code writes to either.

It is also the endpoint the whole `/v1` prefix exists for. Everything downstream — allocation,
freeze, add-on purchase, billing history — either grants credits this path spends or reports on
transactions this path writes.

## What Changes

- **`src/credit/`** — a leaf module owning `CreditWallet` and `CreditTransaction`, serving
  `POST /v1/credits/consume` and `POST /v1/credits/reverse` as shaped in
  [`api-surface.md`](../../../docs/architecture/api-surface.md).
- **`SELECT … FOR UPDATE` on the single wallet row**, then the split across ledgers computed in
  application code, then the write — all in one interactive transaction. Subscription credits first,
  then add-on credits. Serializable isolation is not used; ticket 006 measured it losing a third of
  legitimate consumptions under thirty concurrent callers.
- **One `CreditTransaction` row per ledger drawn from**, sharing the caller's idempotency key. This
  is why the constraint is `@@unique([idempotencyKey, ledger])`; the narrowing is already migrated.
- **The caller's idempotency key is required**, because credits are deducted before the caller does
  its work. Same key and same amount replays the first result as a `200`; same key and a different
  amount is a `400` with `IDEMPOTENCY_KEY_REUSED`. A replay outranks a freeze applied after the
  original call — the retrying caller has already been charged.
- **BREAKING (documented contract only): the consume response returns `transactions: [{ id, ledger,
  amount }]` in place of the scalar `transactionId`** that `api-surface.md` published. One id cannot
  name the two rows a two-ledger consumption writes. No application has integrated against the route
  — this change is what first serves it — so the widening is free now and costs a `/v2` later. A
  decline omits the field rather than sending an empty list, and the reversal response carries no
  `success` flag because a reversal has no outcome to decline.
- **The caller's `reason` is stored on every row a consumption writes**, and reversal rows carry
  none; `reversesId` already records what they undo. `CreditTransaction.reason` exists and nothing
  writes it today.
- **Reversal writes `REVERSAL` rows carrying no idempotency key**, each linked through the `@unique`
  `reversesId` to the consumption row it reverses. That constraint — not a check-then-write — is what
  makes a consumption reversible at most once. Credits return to the ledger they came from, and a
  frozen wallet does not block a reversal.
- **Declines are `200` with `success: false`** and report `INSUFFICIENT_CREDITS` and `BILLING_FROZEN`
  distinctly, each emitting `credits.consume.declined` through the metrics seam from 018.
- **`IDEMPOTENCY_KEY_REUSED` joins the `ErrorCode` union** in `src/common/errors/error-code.ts`. It is
  the first code added since the union was written and the only new one here; the envelope, the
  status mapping, and the filter are untouched.
- **`JwtAuthGuard` moves to the composition root as an `APP_GUARD`, with a `@Public()` decorator on
  the routes that do not need it.** The verified identity — the request property, its type, and the
  `@CurrentUser()` decorator that reads it — moves to `src/common/identity/`. Without this, the credit
  controller would have to import a guard from `auth`, closing the cycle
  `auth ──▶ billing ──▶ credit ──▶ auth` that `module-boundaries.md` forbids. Auth keeps the guard's
  implementation and stays deletable.
- **`module-boundaries.md` records how a leaf module is authenticated without importing `auth`**, and
  `api-surface.md` gains the reversal response shape and the token the two credit routes require —
  both are undocumented today.

**Not in this change:** allocation, freeze and unfreeze (ticket 022), the initial grant at
registration (023), admin adjustment (029), add-on purchase (032), `GET /v1/me/wallet` and billing
history (033). The wallet is read and written here, never created here; tests create it directly.

**No schema change and no migration.** `CreditWallet`, `CreditTransaction`, both unique constraints
and the non-negative `CHECK`s already exist from `init`, `add_ledger_constraints`, and
`credit_tx_idempotency_per_ledger`.

**No new configuration key.**

## Capabilities

### New Capabilities

- `credit-ledger`: what a consumption and a reversal do to the two ledgers — atomicity and draw
  order, behaviour under concurrency, what a repeated idempotency key returns, how a reversal is
  bounded to one, and how a decline is reported and counted.

### Modified Capabilities

None. `platform` already specifies the error envelope these `400` and `404` responses use and the
counter interface the decline metric records through; this change adds a member to the code union and
a first real consumer of the counter, neither of which changes a platform requirement.
`authentication` keeps every requirement it has — the guard is registered in a different place and
the identity it publishes moves module, and both are stated there as implementation, not behaviour.

## Impact

- **New code**: `src/credit/` — `controllers/`, `services/`, `repositories/`, `dto/`,
  `credit.constants.ts`, `credit.errors.ts`, `draw-split.ts`, `credit.module.ts`, plus
  `credit-seam.spec.ts`.
- **Existing code**: `src/common/errors/error-code.ts` gains one member;
  `src/common/identity/` is created from two files moved out of `src/auth/`; `src/auth/` re-points
  those imports and gains `@Public()`; `src/app.module.ts` registers `CreditModule` and the global
  guard. Nothing under `src/billing/` is touched.
- **Tests**: `src/credit/**/*.spec.ts` for the unit and integration rules,
  `test/credit-concurrency.spec.ts`, and `test/credit-http.spec.ts`. The suite truncates rather than
  rolling back, per ticket 010 — consumption opens its own transaction, so a test-owned outer one
  would nest, and the concurrency test needs real parallel connections.
- **Documentation**: `module-boundaries.md`, `api-surface.md`, `requirement-coverage.md`.
- **Dependencies**: none added, none removed.
- **Downstream**: `build-credit-allocation-and-freeze`, `build-registration-provisioning`, and
  `build-addon-purchase` write to the ledger this change opens; `build-billing-history` reads it.
- **Requirement coverage**: this change claims **eight** Section 6 clauses in
  `docs/testing/requirement-coverage.md`, verbatim:
  - *"Consumption is atomic — no partial deduction"*
  - *"Subscription credits are drawn before add-on credits"*
  - *"Concurrent consumption cannot oversell"*
  - *"Consumption is idempotent on the caller's key"*
  - *"Reversal restores credits to the ledger they came from"*
  - *"A consumption can be reversed at most once"*
  - *"Declines report `INSUFFICIENT_CREDITS` and `BILLING_FROZEN` distinctly"*
  - *"A decline emits a metric"*
