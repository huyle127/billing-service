## Why

Registration currently creates a `User` and an `AuthCredential` and stops there. A user who registers
today has no wallet, no plan, and no Stripe identity — every flow queued behind this one assumes all
three exist. Ticket 022 built the primitives that put credits into a wallet; nothing yet calls them,
so a registered user cannot consume a single credit.

This change closes that gap in the shape `stripe-sync.md` designed: entitlement lands in the
registration transaction with no Stripe call in it, and the Stripe objects follow immediately
afterwards through an idempotent routine that converges on its own when Stripe is unreachable.

This change implements wayfinder ticket **023 Build registration provisioning and the Stripe sync
reconciler** (`docs/wayfinder/tickets/023-build-registration-provisioning.md`).

## What Changes

- **The registration transaction is extended, without contacting Stripe.** One transaction now
  creates `User`, `AuthCredential`, `BillingCustomer` with `stripeCustomerId = NULL`, the Free
  `Subscription` with `stripeSubscriptionId = NULL`, the `CreditWallet`, and the Free plan's monthly
  credits already allocated under this month's allocation key. Registration succeeds during a Stripe
  outage; only the ability to *pay* is deferred.
- **`BillingCustomer` is created eagerly with a null id**, not once Stripe answers. A row that
  appeared only on success would leave a failed provisioning with nothing to find, and detecting
  affected users would mean scanning `User` — the full-scan problem the partial indexes exist to
  solve.
- **One idempotent provisioning routine, reached from three triggers**: called at the end of
  registration without blocking the response, swept by a periodic reconciler, and callable
  defensively before any operation needing a Stripe Customer (tickets 031 and 032 are the callers
  that will use the third).
- **The reconciler is state-derived, with no job table and no outbox.** It reads the partial index
  already applied by migration `20260804153434_add_ledger_constraints` —
  `stripeSubscriptionId IS NULL AND status IN (…)` ordered by `syncNextAttemptAt`, `LIMIT` batch
  `FOR UPDATE SKIP LOCKED` — so its cost is proportional to the outstanding backlog rather than to
  table size. `syncAttempts`, `syncNextAttemptAt` and `syncError` live inline on the row.
- **Escalation is by age, not by attempt count.** A row pending longer than a configured threshold is
  logged at error level on every sweep. Retrying forever in silence is the failure mode being
  avoided.
- **An in-process scheduler drives the sweep**, on a configured interval, disabled by setting the
  interval to zero. It invokes the same routine every other trigger invokes.
- **Order is create in Stripe, then persist locally**, since network calls are barred from
  transactions. Crossing that window twice is made harmless by the Stripe idempotency key derived in
  the adapter, our metadata searched before create (Stripe's keys expire in 24 hours), and the unique
  constraint on `stripeCustomerId`.
- **`billing` becomes a real module** — `src/billing/` gains `services/`, `repositories/`,
  `billing.constants.ts` and `billing.module.ts` beside the existing `stripe/` adapter directory.
  `auth ──▶ billing ──▶ credit` is exercised for the first time: `auth` opens the transaction,
  `billing` joins it, `credit` joins through `billing`.
- **The credit ledger gains wallet creation** as a primitive that joins a caller's transaction. The
  wallet is a `credit`-owned table, so `billing` cannot write it directly.

**Not in this change: `POST /v1/internal/provisioning/run` and the `InternalKeyGuard`.** The ticket
placed both here, and they move to ticket 028. With the in-process scheduler shipping in this change
the endpoint has no caller of its own, and ticket 020 settled the rule that decides this — *build an
operation when a caller exists* — which is why 020 rejected asserting the guard against a probe
controller in a test. Ticket 028 is already titled *"Build the annual allocation cron and the
internal endpoints"* and carries `POST /v1/internal/allocations/run`, so one guard is built once
against two real callers instead of once against none. `INTERNAL_API_KEY` stays in configuration
untouched.

No schema change and no migration. `BillingCustomer` and `Subscription` already carry
`syncAttempts`, `syncNextAttemptAt` and `syncError`; both partial indexes and the
one-current-subscription unique index are already applied.

## Capabilities

### New Capabilities

- `subscription-provisioning`: how a new user gets entitlement instantly and a Stripe object shortly
  afterwards — what the registration transaction creates, why a subscription with no Stripe id is a
  valid state rather than an error, what makes the provisioning routine idempotent across the
  Stripe-then-database window, how the backlog is found without scanning, and when a pending row
  becomes an alert.

### Modified Capabilities

- `authentication`: the registration requirement changes shape. The transaction now creates billing
  and credit rows as well as the credential, and the guarantee that it contacts no external service
  becomes load-bearing rather than incidental — it is what lets registration succeed while Stripe is
  down.
- `credit-ledger`: adds wallet creation as a primitive joining a caller's transaction, with one
  wallet per user enforced by the `@unique` on `CreditWallet.userId` rather than by a pre-check.

## Impact

**Requirement clauses moved off `todo`** in `docs/testing/requirement-coverage.md`, Section 3, quoted
verbatim:

- `Registration grants plan and credits without contacting Stripe`
- `Stripe customer and subscription provisioned immediately after registration`
- `A subscription with no Stripe id is a valid intermediate state`

**Requirement clauses re-pointed, not closed.** Section 9's `Internal key yields a service principal
with no user identity` and `Internal endpoints reject "act on behalf of" semantics` currently read
`todo — ticket 023`. They become `todo — ticket 028`, and the note beneath the table is rewritten to
say why, so the deferral stays visible rather than becoming a clause nobody owns.

**Code**: `src/billing/services/`, `src/billing/repositories/`, `src/billing/billing.constants.ts`,
`src/billing/billing.module.ts`; `src/auth/services/auth.service.ts` and `src/auth/auth.module.ts`;
`src/credit/services/credit.service.ts`, `src/credit/repositories/credit-wallet.repository.ts` and
`src/credit/credit.module.ts`; `src/common/config/configuration.ts` and
`src/common/config/app-config.service.ts`; `src/app.module.ts`.

**Configuration**: `PROVISIONING_SWEEP_INTERVAL_MS`, `PROVISIONING_BATCH_SIZE`,
`PROVISIONING_RETRY_BACKOFF_MS`, `PROVISIONING_STALE_AFTER_MS`, added to `.env.example` with
defaults, following the shape `webhookConfig` already uses.

**Docs**: `docs/architecture/api-surface.md` records that the internal provisioning endpoint arrives
with ticket 028; `docs/architecture/module-boundaries.md` records the `billing/` layout now that the
module has services and repositories.

**Unblocks**: ticket 024 (webhook ingestion) and ticket 025 (subscription lifecycle), both of which
attach to the rows this change creates.
