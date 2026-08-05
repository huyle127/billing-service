# Requirement Coverage

The completion criterion for this effort. Every requirement clause with observable behaviour maps
to at least one named test. A clause with no test is not done, whatever the coverage report says.

Status: `covered` · `partial` · `todo`

## Section 3 — Core concepts

| Clause | Test | Status |
| --- | --- | --- |
| A user has exactly one current subscription | `ledger-invariants: at most one current subscription` | covered |
| A subscription awaiting authentication is not current | `ledger-invariants: pending coexists with current` | covered |
| Registration grants plan and credits without contacting Stripe | | todo |
| Stripe customer and subscription provisioned immediately after registration | | todo |
| A subscription with no Stripe id is a valid intermediate state | | todo |
| Expired Pro subscription spawns a new Free subscription | | todo |
| Subscription credits are forfeited when a subscription expires | | todo |
| Cron allocates monthly for annual subscriptions | | todo |
| Cron catches up one month at a time across missed periods | | todo |
| Cron never allocates past the paid-through boundary | | todo |

## Section 4 — Subscription and catalog

| Clause | Test | Status |
| --- | --- | --- |
| Lifecycle states are set by this service, not mirrored from Stripe | | todo |
| Cancel keeps access until period end | | todo |
| Plan creation writes to Stripe then the database | | todo |
| Creation calls carry a Stripe idempotency key | | todo |
| A price change creates a new Stripe price and archives the old | | todo |
| Existing subscribers migrate at next renewal, no proration | | todo |
| The migration reconciler is idempotent and resumable | | todo |
| A price change never triggers credit allocation | | todo |
| Catalog is enumerated locally, never by listing Stripe products | | todo |

## Section 5 — Payments and webhooks

| Clause | Test | Status |
| --- | --- | --- |
| Signature verification against the raw body | | todo |
| Endpoint returns 2xx once the event is persisted | | todo |
| Ingestion is idempotent by Stripe event id | | todo |
| Failed events retry with backoff | | todo |
| Events exceeding the retry budget are dead-lettered | | todo |
| Processing never assumes event ordering | | todo |
| Handlers re-fetch the object rather than trusting the payload | | todo |
| Period-derived state advances monotonically | | todo |
| An event whose subject is missing defers rather than failing | | todo |
| Replaying full history converges on the ordered result | | todo |
| Webhooks never create domain rows | | todo |

## Section 6 — Credits

| Clause | Test | Status |
| --- | --- | --- |
| A balance can never go negative | `ledger-invariants: balance can never go negative` | covered |
| One consumption spans both ledgers under one key | `ledger-invariants: one consumption spans both ledgers` | covered |
| Consumption is atomic — no partial deduction | | todo |
| Subscription credits are drawn before add-on credits | | todo |
| Concurrent consumption cannot oversell | | todo |
| Consumption is idempotent on the caller's key | | todo |
| Reversal restores credits to the ledger they came from | | todo |
| A consumption can be reversed at most once | | todo |
| Declines report `INSUFFICIENT_CREDITS` and `BILLING_FROZEN` distinctly | | todo |
| A decline emits a metric | | todo |
| Wallet freezes when a subscription goes past due | | todo |
| Resolving past due unfreezes and allocates the next period | | todo |
| Add-on credits survive a freeze and never expire | | todo |
| Allocation grants on `subscription_create`, `_cycle`, and `_update` only | | todo |
| Payment detected via `invoice.status`, never the removed `paid` field | | todo |
| Free tier allocates monthly from `invoice.paid` with no separate cron | | todo |
| A mid-cycle plan change grants a full new monthly allocation | | todo |
| Allocation is idempotent on subscription and month | | todo |
| Admin adjustments target add-on credits only | | todo |

## Section 9 — Authentication

| Clause | Test | Status |
| --- | --- | --- |
| Passwords hashed with bcrypt | | todo |
| Refresh token hash stored; logout revokes | | todo |
| User endpoints reject an absent or invalid token | | todo |
| Admin endpoints reject a user token | | todo |
| Internal key yields a service principal with no user identity | | todo |
| Internal endpoints reject "act on behalf of" semantics | | todo |

## Section 10 — Non-functional

| Clause | Test | Status |
| --- | --- | --- |
| Duplicate billing events handled safely | | todo |
| Subscription events recorded for reconciliation | | todo |
| Sensitive payment data never stored locally | | todo |
