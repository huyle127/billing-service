## Why

Ticket 021 built the hot path — consumption and reversal — but nothing yet puts credits *into* a
wallet or stops them being spent. Every flow queued behind this one needs those primitives:
registration provisioning (023) grants the first month, the lifecycle machine (025) forfeits credits
on expiry, the invoice handlers (027) allocate on `invoice.paid` and freeze on
`invoice.payment_failed`, and the annual cron (028) allocates month by month. Building them once,
here, keeps the policy for "what a grant does to a balance" in one place instead of four callers.

This change implements wayfinder ticket **022 Build the credit ledger: allocation, adjustment, and
wallet freeze** (`docs/wayfinder/tickets/022-build-credit-allocation-and-freeze.md`).

## What Changes

- **`allocate(tx, …)` accepts the caller's transaction client** rather than opening its own, so a
  grant lands in the same transaction as subscription activation and the payment record.
- **Allocation is idempotent on an opaque `allocationKey`** supplied by the caller — subscription
  plus month — stored in `CreditTransaction.idempotencyKey` under the existing
  `@@unique([idempotencyKey, ledger])`. The credit module never builds the key and never interprets
  it; that is what keeps `credit` a leaf.
- **A renewal replaces the subscription balance; it does not add to it.** Subscription credits do not
  roll over across billing cycles. A replacing allocation writes a `RESET` row zeroing what was left
  and an `ALLOCATION` row granting the new period, both inside one call so a retry cannot reset a
  balance it already granted. A mid-cycle plan change is the additive case and stays additive.
- **`reset(tx, …)`** as a standalone primitive for the forfeiture of subscription credits when a
  subscription expires. Add-on credits are untouched.
- **`adjust()` targets the add-on ledger only**, enforced in the service so the rule holds for every
  caller, not just the HTTP one. `POST /v1/admin/users/:userId/credits/adjust` ships here; the rest of
  the admin surface belongs to ticket 029. An adjustment that would drive the add-on balance below
  zero is refused with `400` and nothing is written.
- **`freeze(tx, …)` / `unfreeze(tx, …)`** over `WalletStatus`. A freeze gates consumption on **both**
  ledgers and never mutates a balance: add-on credits survive it intact, are not deducted, and never
  expire.
- **`@Roles()` and `RolesGuard` move from `src/auth/` to `common/identity/`,** and `RolesGuard` is
  registered as a second `APP_GUARD` in `auth.module.ts`. The admin adjust route lives in `credit`,
  which cannot import from `auth` without breaking the leaf rule — the same seam problem ticket 021
  solved for `@Public()` and `@CurrentUser()`, solved the same way. No route's observable behaviour
  changes.

No schema change and no migration: `CreditTransaction` already carries `idempotencyKey`,
`stripeInvoiceId` and `periodStart`, `CreditWallet` already carries `status`, and the non-negative
`CHECK` constraints already exist.

## Capabilities

### New Capabilities

None. Everything here belongs to the ledger capability ticket 021 opened.

### Modified Capabilities

- `credit-ledger`: adds allocation, reset, admin adjustment, and the wallet freeze — how a grant
  reaches a ledger, what a repeated allocation key does, why a renewal replaces rather than
  accumulates, and what a freeze does and does not touch.
- `authentication`: the ADMIN role requirement gains how it is enforced — a global guard registered
  by the auth module, with the marker decorator published from `common/identity/` so a leaf module can
  mark an admin route without an import back to `auth`.

## Impact

**Requirement clauses moved off `todo`** in `docs/testing/requirement-coverage.md`, Section 6, quoted
verbatim:

- `Add-on credits survive a freeze and never expire`
- `Allocation is idempotent on subscription and month`
- `Admin adjustments target add-on credits only`

The three freeze- and allocation-trigger clauses that read `Wallet freezes when a subscription goes
past due`, `Resolving past due unfreezes and allocates the next period`, and `Allocation grants on
`subscription_create`, `_cycle`, and `_update` only` stay `todo`: their subject is the invoice handler
that decides *when* to call these primitives, which is ticket 027.

**One clause row is added** to the Section 6 table, because the no-rollover rule is required
behaviour that the checklist does not currently track and a behaviour absent from it is one nothing
will notice is missing: `A renewal replaces subscription credits; unused credits do not roll over`.

**Code**: `src/credit/services/credit.service.ts` (or a sibling service), `src/credit/repositories/`,
`src/credit/controllers/`, `src/credit/dto/`, `src/credit/credit.constants.ts`,
`src/credit/credit.errors.ts`, `src/credit/credit.module.ts`.

**Moved**: `src/auth/decorators/roles.decorator.ts` and `src/auth/guards/roles.guard.ts` to
`src/common/identity/`, with `auth.module.ts` and `test/auth-http.spec.ts` re-pointed.

**Docs**: `docs/architecture/api-surface.md` gains the adjust request and response shapes;
`docs/architecture/module-boundaries.md` records that role enforcement is global and published by
`common/identity/`; `docs/requirements/billing-service-requirements.md` §6 states the no-rollover rule
in the words this change settles it in.

**Unblocks**: tickets 023, 025 and 027, each of which is a caller of one of these primitives.
