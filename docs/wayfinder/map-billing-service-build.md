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

**Working discipline.** This is a learning project, and the point is understanding the build, not
coverage. **Test what can break silently, and nothing else** — row locking and concurrency, database
constraints (asserted by violating them), idempotency and replay paths, money arithmetic, and pure
transition tables. Everything else is written without tests: controllers, Prisma wiring,
configuration, and anything the type system or the global validation pipe already refuses.

One test per risk, not one per scenario. A change's `tasks.md` carries a single test task for each
part that holds real risk rather than a "written test-first" subsection per section — the
`build-credit-allocation-and-freeze` change shipped 20 tests where 7 or 8 would have said the same
thing. Amended 2026-08-06, replacing a blanket `/tdd` for the credit ledger and subscription
lifecycle.

**Amended 2026-08-09, with numbers, because the prose version did not hold.** Ticket 023 shipped
~890 lines of artifact and 24 tests for ~600 lines of code three days after the paragraph above was
written. Ceilings now bind at generation time in the `rules` block of `openspec/config.yaml`:
**proposal 40 lines, design 80 and optional, specs 80, tasks 15, and at most 10 new tests per
change** — the last also recorded in [`strategy.md`](../testing/strategy.md) under "How much to
test". A design file is written only for a decision its own change is the first to make; one that
merely applies settled decisions has none. Exceeding the test budget is allowed and must be argued
in the proposal.

**Ambiguity is asked about, not inferred.** `/opsx:propose` opens with 2-4 grouped questions on the
business rules the ticket leaves open, and waits — only where the answer changes what gets built,
never about layout or naming, which are already fixed here and in `module-boundaries.md`.

**Rules from `AGENTS.md`** that every session must honour: business logic stays out of
controllers; Stripe is an infrastructure adapter; state-changing operations use transactions;
no comments unless requested; prefer early return; code in English, explanations in Vietnamese.

**Stripe.** Pin the webhook endpoint's API version explicitly rather than inheriting the account
default — version `2025-03-31.basil` moved `current_period_end` off the Subscription object and
restructured Invoice, and silent version drift would break the credit cron. Research findings in
[`docs/research/stripe-object-model.md`](../research/stripe-object-model.md) reflect
`2026-07-29.dahlia`.

**Skills to consult.** `/codebase-design`, `/domain-modeling`, `/setup-pre-commit`.

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
- [021 Build the credit ledger: consumption and reversal](tickets/021-build-credit-consumption.md)
  — the hot path is built and all eight Section 6 consumption clauses are covered; `FOR UPDATE`
  behaved as ticket 006 measured. **The published consume response was wrong**: one `transactionId`
  cannot name the two rows a two-ledger consumption writes, so it is now
  `transactions: [{ id, ledger, amount }]` — affordable only because no application has integrated
  yet. Three orderings settled: **replay outranks the freeze** (a retry must not be told its spent
  credits are still there), a second reversal replays rather than failing, and reversal rows carry no
  idempotency key or they collide with the consumption's own. Two findings for later tickets: the
  global auth guard belongs in `auth.module.ts` and the identity contract in `common/identity/`, or
  a leaf module cannot read a caller without closing a cycle; and **Prisma's 2s default `maxWait`
  turns queued callers into server errors**, which the concurrency requirement forbids.
- [022 Build the credit ledger: allocation, adjustment, and wallet freeze](tickets/022-build-credit-allocation-and-freeze.md)
  — `allocate`, `reset`, `freeze`, `unfreeze` and `adjust` are built, all four remaining Section 6
  clauses covered, no schema change. **Subscription credits do not roll over**: a renewal replaces the
  balance and a mid-cycle plan change adds, which resolves the requirements' apparent contradiction.
  The ledger cannot tell the two apart, so the caller passes the intent as a required flag, and the
  `RESET` and `ALLOCATION` legs are written by one call — two calls are not idempotent as a pair.
  **A `P2002` cannot be translated into a replay inside a caller's transaction**, because a unique
  violation aborts it and every later statement fails `25P02`; the wallet lock is the guarantee
  instead, and a surviving collision is cross-wallet, where a replay would answer with someone else's
  row. Also: two rows written in one transaction share a `createdAt`, so `now()` cannot order a
  ledger's history.
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
  [`module-boundaries.md`](../architecture/module-boundaries.md) and in `openspec/config.yaml`, divides its modules: per-module `dto/` and
  `constants/` and one file per handler adopted, its provider-abstraction module and its
  repository-less services not. **Corrected 2026-08-05:** the two adapters disagreed about a missing
  object — the fake returned `null`, the real one threw a permanent failure on Stripe's 404 — so
  every test would have deferred as ticket 017 requires while production dead-lettered the event.
  Fixed with `retrieveOrNull`. The audit that found it concluded **no rewrite**: the seam is wide
  (16 operations, 8 mappers), not deep, and every operation is named by a ticket from 023 to 032.
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
- [020 Build the auth module](tickets/020-build-auth-module.md)
  — shipped through OpenSpec change `build-auth-module`. Registration, login, rotating refresh, and
  logout; plain guards against `JwtService` with **`HS256` pinned once in `JwtModule`**; Passport
  removed. **Built twice** — the first plan was 24 files and 51 tasks, cut to **13 files and 30
  tasks**  whose auth module is ~230
  lines and has no repository layer. That produced three standing rules: **`repositories/` is
  conditional**, an operation is built when a caller exists, and the injected `Clock` is for domain
  time, not for JWT expiry. **The internal API key is deferred to ticket 023**, so this closes
  **four** of Section 9's six clauses rather than all six. Found by test: **rotation reissued an
  identical token**, because a JWT is a pure function of payload, issued-at second, and secret —
  refresh tokens now carry a `jti`. `auth ──▶ billing` added to the graph, putting `auth` where
  deleting it breaks nothing. 23 new tests, 73 total.
- [023 Build registration provisioning and the Stripe sync reconciler](tickets/023-build-registration-provisioning.md)
  — shipped through OpenSpec change `build-registration-provisioning`, and the first ticket to
  exercise `auth ──▶ billing ──▶ credit` end to end. **The sweep is claim-then-work, in two
  transactions**: `FOR UPDATE SKIP LOCKED` holds locks for the life of its transaction and
  provisioning calls Stripe, so one short transaction claims a batch and pushes `syncNextAttemptAt`
  forward, commits, and the work happens with no transaction open. The claim is a **lease** — after
  it commits, a concurrent sweep's due-by predicate no longer matches those rows, so `SKIP LOCKED`
  covers the overlap during the claim and the lease covers it after. Backoff is therefore written
  *before* the attempt, so a sweep that dies mid-flight leaves rows that retry rather than rows
  nothing picks up. **Two services, not one**: `grantOnRegistration(tx, …)` must not touch the
  network and `provision(userId)` does nothing else, and one name over both would hide that. **The
  internal endpoint and `InternalKeyGuard` moved to ticket 028** under ticket 020's own rule — build
  an operation when a caller exists — because the in-process schedule left
  `/v1/internal/provisioning/run` with no caller, and 028 gives the guard two. Found by test: a
  `Date` bound into raw SQL is serialised with the local offset and Postgres's `timestamp` parser
  discards it, skewing the claim predicate by the process time zone — bind `toISOString()` with an
  explicit cast. Also found: the unique `stripeCustomerId` is *not* what makes concurrent
  provisioning safe for one user (both writers update the same row); the adapter's idempotency key
  is. 24 new tests, 152 total.
- [024 Build webhook ingestion and the queue worker](tickets/024-build-webhook-ingestion-and-worker.md)
  — shipped through OpenSpec change `build-webhook-ingestion-and-worker`; behaviour in
  [`webhook-pipeline`](../../openspec/specs/webhook-pipeline/spec.md). **The queue, the worker and
  the retry budget in the ticket's own title were not built** — processing is synchronous and
  **Stripe owns the retry**, since a non-2xx answer is already a request to redeliver on a documented
  backoff. Requirements §5 was amended for this. **Redelivery is judged by the stored status, not by
  the row's existence**: a `COMPLETED` repeat is skipped, anything else is processed again, because
  treating every duplicate as done would silently drop every event whose first attempt failed. The
  signature verifies against a *list* of secrets — `stripe listen` prints a different one from the
  Dashboard's. **The queue's leftovers were swept on 2026-08-10**, once an audit found them: migration
  `20260810120000_drop_webhook_queue_columns` drops `retryCount` and `nextAttemptAt` and rebuilds
  `WebhookStatus` without `PROCESSING` or `DEAD_LETTERED` — Postgres has no `ALTER TYPE … DROP VALUE`,
  so the type is recreated — and the whole `webhookConfig` namespace went with them, four keys no
  code read. Neither column carried information: `retryCount` was `0` on every row and
  `nextAttemptAt` equalled `receivedAt`. Verifying
  forwarding for ticket 002 exposed a defect that had nothing to do with Stripe — `deleteOutDir` plus
  `incremental` made `npm run build` emit **nothing** on every run after the first, exit code 0, and
  `dist/` empty; `incremental` has since been dropped.

- [028 Build the annual allocation cron and the internal endpoints](tickets/028-build-annual-allocation-cron.md)
  — shipped through OpenSpec change `build-annual-allocation-cron`; behaviour in
  [`annual-allocation`](../../openspec/specs/annual-allocation/spec.md). **The claim lease was not
  built and must not be**: ticket 023's `SKIP LOCKED` exists because provisioning calls Stripe, and
  this routine reaches no network, so `CreditService.allocate`'s wallet lock plus the month key
  already serialise concurrent runs — two runs racing one subscription compute the same
  `nextCreditAt` from the same anchor and write the same value. Copying 023 by analogy would add a
  lease with nothing to protect. **`InternalKeyGuard` and the service principal live in
  `common/identity/`, not `auth/`** — `AuthModule` imports `BillingModule`, so a billing controller
  importing a guard from auth closes a cycle; the same constraint ticket 021 hit. The principal is a
  **separate request property**, so `@CurrentUser()` resolves to nothing on an internal route and no
  expression there yields a user id. `@InternalOnly()` composes `@Public()` with the guard in one
  decorator, because a public route that later loses its `@UseGuards` line is open with no error
  anywhere. Found by test: **`forbidNonWhitelisted` does fire on a DTO with no decorated
  properties**, so an empty request DTO makes "rejects act-on-behalf-of" assertable — a route with no
  `@Body()` would answer 200 and silently ignore a `userId`. Also **`CREDIT_ALLOCATION_CRON` had sat
  in `.env` since ticket 009 with nothing reading it**; this is its first caller, moved to an
  `allocation` namespace. 6 new tests, 186 total.
- **A trap found while closing 028, not fixed:** `package.json` has
  `"format": "prettier --write \"src/**/*.ts\""` and `.prettierrc` declares no `printWidth`, so
  Prettier runs at its default 80 while the code is written at 100. Anyone running `npm run format`
  reflows all of `src/`. Setting `"printWidth": 100` closes it; left for whoever decides it.

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
  031, since price-change migration chose no proration.

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

**Merged 2026-08-10, from nine open tickets to seven.** Ticket 027 folded into 026 and ticket 030
into 029. Both splits were drawn around a Stripe object rather than around a decision: 026/027 split
the webhook processor by event type, which put the shuffled-replay convergence test in the half that
could only run against half the event history; 029/030 split the catalog by read-versus-change, which
made both halves restate that Stripe Prices are immutable and build against the same admin
controller. Tickets 028, 031, 032, 033 and 035 were looked at in the same pass and left alone — 028
is already a merge, 032 and 033 each hold one trap worth its own attention, and 035 gets cheaper the
sooner it runs.

**027 → 026, 030 → 029. The numbers were not closed up**, so 027 and 030 are gaps and stay gaps. A
ticket number is an identifier, not a position: closed tickets, archived OpenSpec changes and commit
messages all cite these numbers, and shifting them would leave sealed records pointing at a
different ticket that still reads plausibly — ticket 023 defers its internal key "to 028", which
renumbering would silently repoint at the webhook handlers. Anything citing 027 or 030 means the
pre-merge ticket and should be read at its successor above.

Frontier (open, unblocked, unclaimed):

- [029 Build the plan and add-on catalog, price changes, and subscriber migration](tickets/029-build-plan-catalog-admin.md) — task — unblocked by 020 — merges the old 030
- [033 Build billing history](tickets/033-build-billing-history.md) — task — unblocked by 026
- [035 Decide whether imports use the `@/` path alias](tickets/035-decide-import-path-alias.md) — task — cheapest while only twelve files exist

Blocked:

- [031 Build subscription self-service and payment methods](tickets/031-build-subscription-self-service.md) — task — 029
- [032 Build add-on credit purchase](tickets/032-build-addon-purchase.md) — task — 029, 031

Every build ticket names the requirement clauses it closes. Between them tickets 018–033 account for
all 54 clauses still marked `todo` in
[`requirement-coverage.md`](../testing/requirement-coverage.md), which is this effort's completion
criterion.

Closed:

- [001 Provision Neon and scaffold the repo](tickets/001-provision-neon-and-scaffold-repo.md) — task
- [002 Provision Stripe test account and CLI](tickets/002-provision-stripe-test-account.md) — task — forwarding verified by hand 2026-08-10 against the endpoint 024 built
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
- [020 Build the auth module](tickets/020-build-auth-module.md) — task — OpenSpec change `build-auth-module`, archived; capability spec [`authentication`](../../openspec/specs/authentication/spec.md); four of six Section 9 clauses, the internal API key deferred to 023
- [021 Build the credit ledger: consumption and reversal](tickets/021-build-credit-consumption.md) — task — OpenSpec change `build-credit-consumption`; all eight Section 6 consumption clauses
- [022 Build the credit ledger: allocation, adjustment, and wallet freeze](tickets/022-build-credit-allocation-and-freeze.md) — task — OpenSpec change `build-credit-allocation-and-freeze`, archived; the four remaining Section 6 clauses
- [023 Build registration provisioning and the Stripe sync reconciler](tickets/023-build-registration-provisioning.md) — task — OpenSpec change `build-registration-provisioning`, archived; capability spec [`subscription-provisioning`](../../openspec/specs/subscription-provisioning/spec.md); three Section 3 clauses, the internal key deferred to 028
- [024 Build webhook ingestion and the queue worker](tickets/024-build-webhook-ingestion-and-worker.md) — task — OpenSpec change `build-webhook-ingestion-and-worker`, archived; capability spec [`webhook-pipeline`](../../openspec/specs/webhook-pipeline/spec.md); three Section 5 clauses and one Section 10
- [026 Build the webhook handlers: subscriptions, invoices, and the ordering guarantees](tickets/026-build-webhook-handlers.md) — task — merges the old 027; two OpenSpec changes, `build-webhook-subscription-handlers` and `build-webhook-invoice-handlers`, both archived; capability spec [`webhook-handlers`](../../openspec/specs/webhook-handlers/spec.md); six Section 5 clauses and five Section 6. **Corrected 2026-08-10 while preparing 028**: `nextCreditAt` advanced with `setUTCMonth(+1)` off `period.start`, which overflows a short month — an annual term starting 31 January dated the next credit at 3 March, so February's allocation key was never minted. The arithmetic moved to `src/billing/services/credit-schedule.ts`, **anchored on the day-of-month of `paidThroughAt` rather than chained off the previous value**, because chaining drifts backwards and grants a thirteenth month inside a twelve-month term. Recorded in [028](tickets/028-build-annual-allocation-cron.md), which calls that one function and mints no key of its own
- [028 Build the annual allocation cron and the internal endpoints](tickets/028-build-annual-allocation-cron.md) — task — OpenSpec change `build-annual-allocation-cron`, archived; capability spec [`annual-allocation`](../../openspec/specs/annual-allocation/spec.md); three Section 3 clauses and the two Section 9 internal-key clauses, deferred 020 → 023 → here
- [025 Build the subscription lifecycle state machine](tickets/025-build-subscription-lifecycle.md) — task — OpenSpec change `build-subscription-lifecycle`, archived; capability spec [`subscription-lifecycle`](../../openspec/specs/subscription-lifecycle/spec.md); two Section 3 clauses, two Section 4, one Section 6 taken over from 027, one Section 10
