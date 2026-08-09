# Requirement Coverage

The completion criterion for this effort. Every requirement clause with observable behaviour maps
to at least one named test. A clause with no test is not done, whatever the coverage report says.

Status: `covered` · `partial` · `todo`

## Section 3 — Core concepts

| Clause | Test | Status |
| --- | --- | --- |
| A user has exactly one current subscription | `ledger-invariants: at most one current subscription` | covered |
| A subscription awaiting authentication is not current | `ledger-invariants: pending coexists with current` | covered |
| Registration grants plan and credits without contacting Stripe | `entitlement.service: writes the customer, the Free subscription, the wallet and the grant, with no Stripe id` · `auth.service: registers while every Stripe operation fails, leaving both identifiers null` · `auth-http: hands back a user already holding a plan and a balance` | covered |
| Stripe customer and subscription provisioned immediately after registration | `provisioning.service: attaches both identifiers and leaves no sync state behind` · `provisioning.service: creates nothing a second time when it runs again` · `provisioning.service: adopts an object Stripe already holds once the idempotency key has expired` | covered |
| A subscription with no Stripe id is a valid intermediate state | `auth-http: spends the registration grant straight away, and writes nothing for a repeated email` · `provisioning.service: sweeps everything outstanding and leaves a row not yet due alone` · `provisioning.service: never picks up an expired subscription, because history is not a backlog` | covered |
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
| A balance can never go negative | `ledger-invariants: neither balance can go negative, which is what an over-large adjustment leans on` | covered |
| One consumption spans both ledgers under one key | `ledger-invariants: one consumption spans both ledgers` | covered |
| Consumption is atomic — no partial deduction | `credit.service: deducts the whole amount / deducts nothing when the amount exceeds both ledgers` | covered |
| Subscription credits are drawn before add-on credits | `draw-split: exhausts subscription before add-on; credit.service: spans both ledgers, subscription first` | covered |
| Concurrent consumption cannot oversell | `credit-concurrency: never oversells a wallet the callers collectively exceed` | covered |
| Consumption is idempotent on the caller's key | `credit.service: replays the first result for a repeated key; credit-concurrency: charges once when one key is retried in parallel` | covered |
| Reversal restores credits to the ledger they came from | `credit.service: reverses a two-ledger consumption back to both ledgers / restores to the ledger the credits came from` | covered |
| A consumption can be reversed at most once | `ledger-invariants: a consumption can be reversed at most once; credit.service: replays the first reversal` | covered |
| Declines report `INSUFFICIENT_CREDITS` and `BILLING_FROZEN` distinctly | `credit.service: declines a shortfall and a frozen wallet distinctly; credit-http: reports a decline as a 200 carrying no transactions` | covered |
| A decline emits a metric | `credit.service: counts every decline by reason / counts nothing for a transaction that rolled back` | covered |
| Wallet freezes when a subscription goes past due | | todo |
| Resolving past due unfreezes and allocates the next period | | todo |
| Add-on credits survive a freeze and never expire | `credit.service: takes nothing and records nothing when a wallet is frozen / refuses a draw the add-on ledger could satisfy, and allows it again once unfrozen / changes nothing when a frozen wallet is frozen or an active one unfrozen` | covered |
| A freeze gates consumption only — allocation, adjustment and reset still apply | `credit.service: lets a frozen wallet be allocated to, adjusted, and reset` | covered |
| Expiry forfeits what the subscription ledger still holds | `credit.service: forfeits what the subscription ledger holds and leaves add-on standing / writes no row when there is nothing left to forfeit` | covered |
| Allocation grants on `subscription_create`, `_cycle`, and `_update` only | | todo |
| Payment detected via `invoice.status`, never the removed `paid` field | | todo |
| Free tier allocates monthly from `invoice.paid` with no separate cron | | todo |
| A mid-cycle plan change grants a full new monthly allocation | | todo |
| Allocation is idempotent on subscription and month | `credit.service: grants nothing further for a repeated key and names the first row / grants twice for two keys the ledger cannot tell apart; ledger-invariants: an allocation key is spent once per ledger, as a consumption key is` | covered |
| A renewal replaces subscription credits; unused credits do not roll over | `credit.service: lands a replacing grant on the plan amount and forfeits the remainder / does not zero a balance twice when a replacing grant is retried / adds a non-replacing grant, and refuses to replace the add-on ledger` | covered |
| Admin adjustments target add-on credits only | `credit.service: credits and debits the add-on ledger alone, carrying the admin reason / refuses a debit larger than the add-on ledger and allows one down to zero / leaves the subscription ledger unreachable by any adjustment; credit-http: adjusts the wallet named in the path for an admin, and nobody else / refuses a malformed adjustment, a named ledger, and a debit the wallet cannot cover` | covered |

## Section 9 — Authentication

| Clause | Test | Status |
| --- | --- | --- |
| Passwords hashed with bcrypt | `auth.service: stores a bcrypt hash and never the password` | covered |
| Refresh token hash stored; logout revokes | `auth.service: stores the hash of the refresh token it hands out, not the token` · `auth.service: clears the stored hash on logout` | covered |
| User endpoints reject an absent or invalid token | `auth-http: rejects every shape of unusable access token with 401` | covered |
| Admin endpoints reject a user token | `auth-http: lets an admin token through and turns a user token away` | covered |
| Internal key yields a service principal with no user identity | | todo — ticket 028 |
| Internal endpoints reject "act on behalf of" semantics | | todo — ticket 028 |

The last two are deferred deliberately, and the deferral moved from ticket 023 to ticket 028. Ticket
023 was going to ship `POST /v1/internal/provisioning/run`; it shipped an in-process schedule for the
provisioning sweep instead, which left that endpoint with no caller of its own. The rule that decides
this is ticket 020's own — build an operation when a caller exists — and it is why 020 refused to
assert the guard against a probe controller living in a test. Ticket 028 carries
`POST /v1/internal/allocations/run` and now carries the provisioning route too, so one guard gets
built once against two real callers rather than once against none.

## Section 10 — Non-functional

| Clause | Test | Status |
| --- | --- | --- |
| Duplicate billing events handled safely | | todo |
| Subscription events recorded for reconciliation | | todo |
| Sensitive payment data never stored locally | | todo |
