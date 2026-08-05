# Map: Build the Billing Service

<!-- label: wayfinder:map -->
<!-- tracker: local-markdown -->
<!-- tickets: docs/wayfinder/tickets/ -->

## Destination

A feature-complete Billing Service running locally: every requirement in
`docs/requirements/billing-service-requirements.md` implemented, integrated with Stripe test
mode, covered by tests, and startable with a single npm script against a Neon database.

Not included: cloud deployment, CI/CD, production hardening, monitoring.

## Notes

**This map carries execution.** It overrides wayfinder's plan-don't-do default: tickets include
build work, not only decisions.

**Domain.** Subscription billing, credit ledgers, and Stripe synchronization. Source documents:
`docs/requirements/billing-service-requirements.md` and `docs/architecture/domain-model.md`.
`docs/architecture/architecture.md` and `docs/architecture/module-boundaries.md` are empty stubs
that this effort fills.

**Stack.**

| Concern | Choice |
| --- | --- |
| Language / runtime | TypeScript on Node |
| Framework | NestJS |
| ORM | Prisma |
| Database | Neon (serverless PostgreSQL) |
| Async pipeline | Postgres-backed queue over the `WebhookEvent` table, `FOR UPDATE SKIP LOCKED` |
| Local infra | Neon only. No Docker, no Redis. |

**Database identifiers match the Prisma model names exactly** — table `"CreditWallet"`, column
`"subscriptionCredits"`. There are no `@@map` or `@map` directives. Consequence: **every identifier
in hand-written SQL must be double-quoted**, because Postgres folds unquoted identifiers to lower
case and an unquoted `CreditWallet` resolves to a nonexistent `creditwallet`. This has already
caused one failure and will again if forgotten.

**Migrations: always `prisma migrate`, never `prisma db push`.** `db push` produces no migration
file, so the hand-written constraints in `prisma/sql/constraints.sql` — non-negative balances and
the one-current-subscription index — would have nowhere to live and would never reach the database.
For a money ledger the migration history is also the audit trail. `db push` is not to be used even
for a quick local reset.

**Neon constraints.** Prisma needs a pooled `DATABASE_URL` (with `pgbouncer=true`) plus a
`DIRECT_URL` for migrations. The `@neondatabase/serverless` HTTP driver does not support
interactive transactions; since this system depends on them, the connection path must be verified
before the ledger is built. Neon database branching is a candidate for test isolation.

**Auth.** An in-repo minimal auth module (registration, login, bcrypt, JWT, USER/ADMIN roles)
exists so the service is self-contained for development and demonstration. It is expected to be
replaced by an upstream Authentication Service, so it must be built as a replaceable seam:
billing code depends on a verified identity and role, never on the auth module's tables.

**Working discipline.** TDD (`/tdd`) for the credit ledger and subscription lifecycle rules;
tests written after implementation for controllers, Prisma wiring, and configuration.

**Rules from `AGENTS.md`** that every session must honour: business logic stays out of
controllers; Stripe is an infrastructure adapter; state-changing operations use transactions;
no comments unless requested; prefer early return; code in English, explanations in Vietnamese.

**Stripe.** Pin the webhook endpoint's API version explicitly rather than inheriting the account
default — version `2025-03-31.basil` moved `current_period_end` off the Subscription object and
restructured Invoice, and silent version drift would break the credit cron. Research findings in
[`docs/research/stripe-object-model.md`](../research/stripe-object-model.md) reflect
`2026-07-29.dahlia`.

**Skills to consult.** `/tdd`, `/codebase-design`, `/domain-modeling`, `/setup-pre-commit`.

**OpenSpec runs alongside this map** as of 2026-08-05 (`openspec/`, schema `spec-driven`). Two
systems, one route — the split is fixed so they cannot drift:

| | Authoritative for |
| --- | --- |
| This map and its tickets | The route. Why a decision went the way it did, what is blocked on what, what is still fog. |
| `openspec/changes/<name>/` | One wayfinder build ticket's spec delta, design note, and task list. |
| `openspec/specs/<capability>/` | What the system **actually does** — grows only when a change is archived after being built. |
| `docs/testing/requirement-coverage.md` | Completion: which requirement clause is asserted by which named test. |

**One build ticket, one change, created when the ticket is claimed** — not up front. Sixteen active
changes would be sixteen plans nobody is working, which is the drift this split exists to prevent.
Change names are the ticket titles in kebab-case; `openspec/config.yaml` carries the project context
and the damage-causing rules, so every generated artifact inherits them.

The unavoidable overlap is `requirement-coverage.md` against the OpenSpec delta specs — both describe
required behaviour. The coverage table stays authoritative for *am I done*, the specs for *what does
this do*, and every change's final task writes the clause back to the table. Once all 54 clauses are
covered the table has served its purpose and can retire in favour of the specs.

## Decisions so far

<!-- one line per closed ticket -->

- [003 Research Stripe object model and webhook semantics](tickets/003-research-stripe-object-model.md)
  — Stripe's objects, statuses, event guarantees and testing affordances documented in
  [`docs/research/stripe-object-model.md`](../research/stripe-object-model.md) against API version
  `2026-07-29.dahlia`. Found two factual errors in our own docs (`current_period_end` no longer on
  the Subscription object; Stripe issues proration credits, not refunds), a status vocabulary that
  cannot round-trip, an unsafe credit trigger, and no ordering guarantee. Spawned tickets 012–017.
- [013 Decide the Stripe-to-domain status mapping](tickets/013-decide-stripe-status-mapping.md)
  — **there is no mapping.** The four lifecycle states belong to the Billing Service and are set by
  it; Stripe events are inputs that trigger transitions, and no business rule reads a Stripe status.
  `stripeStatus` is stored verbatim for reconciliation only. This dissolves the homeless-status
  problem and the Dashboard-setting risk. A subscription pending 3DS/SCA still does not become
  current.
- [016 Decide the credit allocation trigger and idempotency key](tickets/016-decide-credit-allocation-trigger.md)
  — allocate on `billing_reason` of `subscription_create`, `subscription_cycle`, or
  `subscription_update`. **A mid-cycle plan change granting a full new monthly allocation is an
  intentional business rule, not a defect** — credits are never prorated, only money is. Allocation
  idempotency keys on invoice ID plus billing period, enforced by a uniqueness constraint.
- [017 Design out-of-order webhook handling](tickets/017-design-out-of-order-webhook-handling.md)
  — processing never assumes event ordering. Re-fetch the object from Stripe on receipt, guard
  period-derived state monotonically, defer rather than fail when the subject is missing, and
  enforce idempotency at two layers. Replaying full history must converge on the ordered result.
- [012 Correct the requirements and domain model from Stripe research](tickets/012-correct-docs-from-stripe-research.md)
  — both factual errors fixed: the cron now reads a paid-through boundary we own and persist from
  `invoice.period_end`, and proration credits replace the non-existent Stripe-initiated refunds.
- [004 Design module boundaries and layering](tickets/004-design-module-boundaries.md)
  — four modules (`auth`, `user`, `billing`, `credit`), each `controllers/services/repositories`,
  `credit` a leaf. No use-case layer, no hexagonal ports. **Cross-module calls are direct and share
  a transaction**; the event bus carries only audit and notification, because an in-process emitter
  cannot join the caller's transaction and §5 demands aggregate atomicity. Auth owns credentials
  only and is built to be deleted; `user` survives it. Stripe confined to `billing/stripe/`, clock
  injected, webhook pipeline kept inside billing. Written to
  [`architecture.md`](../architecture/architecture.md) and
  [`module-boundaries.md`](../architecture/module-boundaries.md).
- [007 Design the persistence schema](tickets/007-design-persistence-schema.md)
  — `prisma/schema.prisma` plus `prisma/sql/constraints.sql`. Wallet is **one row with two balance
  columns**, so consumption locks a single row. Subscription gains a fifth state **`PENDING`** —
  forced by ticket 013's 3DS decision, which left such rows with nowhere to sit in the four-value
  enum. "Current" is `status IN (ACTIVE, CANCELED, PAST_DUE)`, enforced by a partial unique index.
  Money and credits are integers throughout. Allocation idempotency is a composite unique on
  `(stripeInvoiceId, periodStart)`, relying on Postgres treating NULLs as distinct.
- [008 Decide plan and add-on package configuration](tickets/008-decide-plan-configuration.md)
  — the source-of-truth question dissolved: Stripe owns **price**, we own **credit entitlement**, so
  a local `Plan` table is required either way. **Full admin CRUD** — the service creates Stripe
  Products and Prices, with idempotency keys, Stripe-first-then-database, and archive-never-delete.
  Prices are immutable, so a price change creates a new Price; **existing subscribers migrate at
  next renewal with no proration**, driven by a state-derived reconciler rather than a stored job.
  Choosing no proration also avoids turning a price change into a mass credit giveaway. Recorded in
  requirements §4 "Plan Catalog Management". Also produced `prisma.config.ts` — **Prisma 7 removed
  the `url`/`directUrl` datasource properties**.
- [014 Decide Free plan modelling](tickets/014-decide-free-plan-modelling.md)
  — **Free is a real Stripe subscription at $0**, and every user gets a Stripe Customer. Decided
  ahead of ticket 015, which stays open: if a $0 price turns out not to emit `invoice.paid` monthly,
  Free allocation moves to the annual cron. Exposed a double-allocation bug about to be built in —
  the registration grant and the first $0 `invoice.paid` would both have fired — and forced the
  allocation idempotency key to become an opaque **`allocationKey`** (subscription + month) instead
  of `(stripeInvoiceId, periodStart)`, which could not cover the invoice-less paths.
- [009 Design the auth module](tickets/009-design-auth-module.md) (also resolves
  [005](tickets/005-amend-requirements-auth-scope.md))
  — HS256 access plus refresh, claims limited to subject/role/expiry; **bcrypt for passwords,
  SHA-256 for refresh tokens, HS256 for signing** — three jobs, three algorithms, recorded because
  confusing them is a real vulnerability. OAuth out of scope. **The internal API key yields a service
  principal with no user identity**, so a leaked key cannot impersonate anyone. Billing depends only
  on a verified principal from a guard, never on `AuthCredential`. Registration provisions the
  database eagerly and Stripe immediately afterwards, with recovery designed in
  [`stripe-sync.md`](../architecture/stripe-sync.md). Allocation cron runs from both an in-process
  schedule and an internal-key endpoint, one idempotent routine.
- [011 Design the API surface and error model](tickets/011-design-api-surface.md)
  — [`api-surface.md`](../architecture/api-surface.md). **Consumption deducts before the caller
  works**, with a caller-supplied idempotency key under a unique constraint. That forced a new
  **`REVERSAL`** transaction type: `adjustment` is admin-only and add-on-only, so there was no
  legitimate way to return subscription credits after a failed operation. **Business outcomes return
  200 with a result object** — recommended against, so the service must now emit a decline counter,
  since nothing downstream can infer a decline from a success status. `/v1` from the start; cursor
  pagination on history.
- [001 Provision Neon and scaffold the repo](tickets/001-provision-neon-and-scaffold-repo.md)
  — repo scaffolded and **verified running**: NestJS 11, Prisma 7.9.1, TypeScript 6, two migrations
  applied via `migrate dev`, catalog seeded from the real Stripe price IDs. The open adapter
  question is settled — **`@prisma/adapter-pg`**, with interactive transactions confirmed working
  over Neon, which partially de-risks ticket 006. Constraints were verified by attempting to violate
  them: all twelve behaved correctly. Notable snags: `constraints.sql` had to be rewritten for
  quoted camelCase columns, and **TypeScript 7.0 is incompatible with the Nest CLI** (no
  programmatic compiler API until 7.1) so the project is pinned to TS 6.
- [006 Prototype atomic two-ledger consumption](tickets/006-prototype-atomic-consumption.md)
  — the Prisma concern raised while charting is **closed**. Raced three strategies with 30
  concurrent callers: **`SELECT … FOR UPDATE` wins**, a single conditional `UPDATE` ties it, and
  **Serializable is rejected** — it lost 20 of 30 requests to unrecoverable serialization conflicts,
  under-serving without any safety gain. Exposed a defect: each transaction is tied to one ledger,
  so a consumption spanning both writes two rows, which a key-only unique made impossible. The
  constraint is now **`@@unique([idempotencyKey, ledger])`**, migrated and verified by violation.
- [010 Decide the testing strategy](tickets/010-decide-testing-strategy.md)
  — [`strategy.md`](../testing/strategy.md) plus a **requirement checklist as the completion
  criterion**, not a coverage threshold. **Vitest with `unplugin-swc`** — mandatory, since Vitest's
  esbuild transform drops `emitDecoratorMetadata` that NestJS DI needs. Separate `billing_test`
  database on the same Neon project, truncated per test, with a guard refusing to run if it matches
  the development URL. **Transaction-rollback-per-test rejected** — consumption opens its own
  transaction, so nesting breaks rollback, and concurrent tests need two connections anyway.
  Harness proven: five tests passing.
- [018 Build the common layer](tickets/018-build-common-layer.md)
  — the first build ticket, shipped through OpenSpec change `build-common-layer`; behaviour now lives
  in [`openspec/specs/platform/spec.md`](../../openspec/specs/platform/spec.md). Clock, five
  `registerAs` config namespaces validating **at boot**, one error envelope, `/v1`, a counter seam,
  and the raw body. 23 tests, up from 5. **ESLint did not exist in this project** despite `AGENTS.md`
  implying it did, so it was added — minimally, one rule. Two design decisions were revised on contact
  with the code: raw body stays global (Nest's own option; scoping it would mean hand-wiring the body
  parser on the one route whose failure is silent), and the error-code union ships five codes, because
  a filter that catches everything must map 401 and 403 rather than mislabel them `INTERNAL_ERROR`.
- [019 Build the Stripe adapter seam and its test fake](tickets/019-build-stripe-adapter.md)
  — shipped through OpenSpec change `build-stripe-adapter`. Sixteen operations behind an **abstract
  class used as its own injection token**, so the compiler proves the fake satisfies the real shape;
  domain types only, no listing operation, and a test that fails if anything outside
  `src/billing/stripe/` imports `stripe`. Idempotency keys are derived **inside** the adapter so the
  fast path and the reconciler cannot disagree. 27 new tests, none touching the network. Three
  discoveries: `constructEvent`'s `receivedAt` is **milliseconds**, so the tolerance window silently
  never fired; the ticket-018 lint rule banned `new Date(value)` too and was narrowed to zero-arg;
  and `Invoice.subscription` is now `invoice.parent.subscription_details.subscription`. One decision
  revised — an inbound event's `api_version` is set Stripe-side, so a mismatch is **logged, not
  rejected**; rejecting would drop real traffic during a version change. Also the ticket under which
  the **directory layout and the no-literals rule became binding** in
  [`module-boundaries.md`](../architecture/module-boundaries.md) and in `openspec/config.yaml`, after
  reading how `nghiahoangDigiEx/AI-billing-service` divides its modules: per-module `dto/` and
  `constants/` and one file per handler adopted, its provider-abstraction module and its
  repository-less services not.
- [034 Determine the Stripe account's billing mode](tickets/034-determine-stripe-billing-mode.md)
  — **`flexible`**, with `proration_discounts: "included"`, read from four existing subscriptions
  created weeks apart, so it is the account default rather than a per-object override. Ticket 003
  guessed the *shape* wrong and the guess was the dangerous kind: `billing_mode` is an object, not a
  scalar, so `=== 'flexible'` compiles and is always false. Read `billing_mode.type`. Same failure
  shape as the removed `invoice.paid` boolean.
- [015 Prototype $0 recurring price and monthly `invoice.paid`](tickets/015-prototype-zero-price-invoice-paid.md)
  — **confirmed**: a $0 recurring price produces one invoice per month indefinitely and emits
  `invoice.paid` each time (`subscription_create` then `subscription_cycle`). Free-tier allocation
  needs no separate scheduler, validating the bet made in ticket 014. Also found that the Invoice
  object's **`paid` boolean now reads `undefined`** — falsy, so `if (invoice.paid)` would silently
  never allocate. Use `status === 'paid'`. Confirmed directly that period fields live on the
  subscription *item*.

## Not yet specified

- **Observability**: the logging approach for Stripe reconciliation. Narrower than it was — ticket
  018 gives the service a metrics counter seam, and `SubscriptionEvent` is already the audit trail
  for reconciliation. What remains unsharp is structured logging: what is logged on a deferral, a
  dead-letter, or a sync escalation, and in what shape.
- **Demo seed data** for local demonstration. `prisma/seed.ts` seeds the catalog; a demonstrable
  user journey needs more, and its shape depends on which flows land first.

Graduated out of the fog by ticket 003: mid-period upgrade and proration, which was previously
listed here, is now split between ticket 016 (the credit side) and ticket 012 (correcting the
incorrect refund assumption).

Graduated by ticket 009: the cron/scheduler mechanism. Allocation is one idempotent routine reached
from both an in-process schedule and an internal-key endpoint, so the choice no longer has to be
made — and `INTERNAL_API_KEY` now has a reason to exist.

Graduated on 2026-08-05, once module boundaries (004), the persistence schema (007), the API surface
(011), and the testing strategy (010) had all landed:

- **The implementation tickets themselves** → the seventeen build tickets 018–034 below, sourced
  from the 54 clauses still marked `todo` in
  [`requirement-coverage.md`](../testing/requirement-coverage.md).
- **Billing History materialization** → folded into
  [033 Build billing history](tickets/033-build-billing-history.md) as the one decision that ticket
  makes before writing the query.
- **Idempotency on the credit consumption API** → already answered by ticket 011: the caller supplies
  the key and a unique constraint detects the replay. It is built in
  [021 Build the credit ledger: consumption and reversal](tickets/021-build-credit-consumption.md),
  not decided again.
- **Stripe `billing_mode`** → [034 Determine the Stripe account's billing
  mode](tickets/034-determine-stripe-billing-mode.md). Sharp enough to ticket, and it blocks only
  031, since ticket 030 chose no proration for price-change migration.

**Coverage gaps found while charting.** `requirement-coverage.md` has **no Section 7 or Section 8
table**, so add-on purchase and billing history are tracked by nothing, and it carries no rows for the
self-service subscription or payment-method endpoints. Tickets 031, 032, and 033 each add their
missing rows before satisfying them. The checklist is this effort's completion criterion, so a
behaviour absent from it is a behaviour nothing will notice is missing.

## Out of scope

Ruled beyond this destination. These never graduate.

- Everything in requirements §11 **except** the auth override: B2B/team billing, multiple users
  sharing one subscription, multiple payment providers, refund workflow, tax calculation, trial
  system, AI business logic.
- Cloud deployment, CI/CD pipelines, production monitoring, secrets management. The destination
  is a locally running service.
- The upstream User Service as a real integration. Only the seam is designed.
- The upstream Authentication Service. The in-repo auth module stands in for it deliberately.

## Tickets

Frontier (open, unblocked, unclaimed):

- [002 Provision Stripe test account and CLI](tickets/002-provision-stripe-test-account.md) — task — only `stripe listen` forwarding left, checkable once 024 lands
- [020 Build the auth module](tickets/020-build-auth-module.md) — task — unblocked by 018
- [024 Build webhook ingestion and the queue worker](tickets/024-build-webhook-ingestion-and-worker.md) — task — unblocked by 019
- [035 Decide whether imports use the `@/` path alias](tickets/035-decide-import-path-alias.md) — task — cheapest while only twelve files exist

Blocked:

- [021 Build the credit ledger: consumption and reversal](tickets/021-build-credit-consumption.md) — task — 020 — `/tdd`
- [022 Build the credit ledger: allocation, adjustment, and wallet freeze](tickets/022-build-credit-allocation-and-freeze.md) — task — 021 — `/tdd`
- [023 Build registration provisioning and the Stripe sync reconciler](tickets/023-build-registration-provisioning.md) — task — 020, 022
- [025 Build the subscription lifecycle state machine](tickets/025-build-subscription-lifecycle.md) — task — 022, 023 — `/tdd`
- [026 Build the subscription webhook handlers and the ordering guarantees](tickets/026-build-subscription-webhook-handlers.md) — task — 024, 025
- [027 Build the invoice webhook handlers and the credit allocation triggers](tickets/027-build-invoice-handlers-and-allocation.md) — task — 022, 024, 025
- [028 Build the annual allocation cron and the internal endpoints](tickets/028-build-annual-allocation-cron.md) — task — 027
- [029 Build the plan and add-on catalog with admin CRUD](tickets/029-build-plan-catalog-admin.md) — task — 020
- [030 Build the price change and subscriber migration reconciler](tickets/030-build-price-change-migration.md) — task — 029
- [031 Build subscription self-service and payment methods](tickets/031-build-subscription-self-service.md) — task — 023, 025, 029, 034
- [032 Build add-on credit purchase](tickets/032-build-addon-purchase.md) — task — 027, 029, 031
- [033 Build billing history](tickets/033-build-billing-history.md) — task — 021, 025, 027

Every build ticket names the requirement clauses it closes. Between them tickets 018–033 account for
all 54 clauses still marked `todo` in
[`requirement-coverage.md`](../testing/requirement-coverage.md), which is this effort's completion
criterion.

Closed:

- [001 Provision Neon and scaffold the repo](tickets/001-provision-neon-and-scaffold-repo.md) — task
- [003 Research Stripe object model and webhook semantics](tickets/003-research-stripe-object-model.md) — research
- [006 Prototype atomic two-ledger consumption](tickets/006-prototype-atomic-consumption.md) — prototype
- [004 Design module boundaries and layering](tickets/004-design-module-boundaries.md) — grilling
- [005 Amend requirements for auth scope override](tickets/005-amend-requirements-auth-scope.md) — task
- [007 Design the persistence schema](tickets/007-design-persistence-schema.md) — grilling
- [008 Decide plan and add-on package configuration](tickets/008-decide-plan-configuration.md) — grilling
- [009 Design the auth module](tickets/009-design-auth-module.md) — grilling
- [010 Decide the testing strategy](tickets/010-decide-testing-strategy.md) — grilling
- [011 Design the API surface and error model](tickets/011-design-api-surface.md) — grilling
- [012 Correct the requirements and domain model from Stripe research](tickets/012-correct-docs-from-stripe-research.md) — task
- [013 Decide the Stripe-to-domain status mapping](tickets/013-decide-stripe-status-mapping.md) — grilling
- [014 Decide Free plan modelling](tickets/014-decide-free-plan-modelling.md) — grilling
- [015 Prototype $0 recurring price and monthly `invoice.paid`](tickets/015-prototype-zero-price-invoice-paid.md) — prototype
- [016 Decide the credit allocation trigger and idempotency key](tickets/016-decide-credit-allocation-trigger.md) — grilling
- [017 Design out-of-order webhook handling](tickets/017-design-out-of-order-webhook-handling.md) — grilling
- [034 Determine the Stripe account's billing mode](tickets/034-determine-stripe-billing-mode.md) — task
- [018 Build the common layer](tickets/018-build-common-layer.md) — task — OpenSpec change `build-common-layer`
- [019 Build the Stripe adapter seam and its test fake](tickets/019-build-stripe-adapter.md) — task — OpenSpec change `build-stripe-adapter`, archived; capability spec [`stripe-adapter`](../../openspec/specs/stripe-adapter/spec.md)
