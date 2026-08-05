# 010 Decide the testing strategy

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- output: docs/testing/strategy.md, docs/testing/requirement-coverage.md -->
<!-- blocked-by: -->

## Question

How is this service tested, given the destination requires it to be covered by tests?

The hard parts are not unit tests of pure rules — those are straightforward and TDD covers them.
The hard parts are the integration surfaces.

Questions to resolve:

- **Test database.** Neon supports database branching, which could give each test run an isolated
  branch. Is that fast enough and cheap enough, or is a transaction-rollback-per-test approach on
  a single database better? Note there is no local Postgres container to fall back on — the map
  committed to Neon-only infra.
- **Faking Stripe.** Ticket 003 narrowed this considerably and two options are now ruled out:
  `stripe-mock` is stateless by design and Stripe has said they will not make it stateful, so it
  cannot carry lifecycle tests; `stripe trigger` creates real objects and fires cascading extra
  events, so it suits only smoke-testing the signature and parse path. **Test clocks are the only
  viable option for lifecycle scenarios** — but they are sandbox-only, so lifecycle tests cannot run
  in a fully offline CI unless we mock at the HTTP boundary ourselves. Decide what runs where.
- **Test clock limits** to design around: 2 intervals per advance, 3 customers and 3 subscriptions
  per customer, 20 invoices per subscription per day, auto-deleted after 30 days, and they
  **cannot fail payments during advancement** — so dunning and `past-due` tests need declining test
  cards set up before advancing, not the clock itself.
- **An injectable application clock is mandatory, not optional.** A Stripe test clock does not move
  our scheduler, so the annual plan's monthly allocation, catch-up across missed months, and
  stop-at-period-end are untestable without it. The seam is designed in ticket 004; this ticket
  decides how tests drive it.
- **Webhook signing secrets differ** between `stripe listen` and the Dashboard. The verifier should
  accept a list of secrets so rotation and local development do not break each other.
- **Time-dependent behaviour.** Subscription renewal, expiry, and annual cron catch-up across
  missed months all span real calendar time. Stripe test clocks may help for the Stripe side, but
  the cron's own clock also needs controlling. How is time injected?
- **The webhook queue worker.** How are retry, backoff, and dead-lettering tested without waiting
  for real backoff intervals?
- **Concurrency.** The oversell scenario from 006 needs a repeatable concurrent test, not a
  sequential approximation. What harness makes that reliable rather than flaky?
- What does "feature-complete and covered" mean concretely — a coverage threshold, or a checklist
  of requirement clauses mapped to tests? The latter is probably more honest for this destination.

## Answer

Written to `docs/testing/strategy.md`, with the completion criterion tracked in
`docs/testing/requirement-coverage.md`. The harness is installed and proven — five tests pass
against the real test database.

**Runner: Vitest with `unplugin-swc`.** Chosen over Jest for a project-specific reason: this
codebase runs TypeScript 6 and already had to downgrade once around it. `ts-jest` tracks TypeScript
releases and lags major versions; Vitest transforms through esbuild and swc and does not depend on
the TypeScript compiler. **`unplugin-swc` is mandatory, not a nicety** — Vitest's default esbuild
transform drops `emitDecoratorMetadata`, which NestJS constructor injection requires, and the
resulting failure does not point at its cause.

**Test database: a separate `billing_test` database on the same Neon project**, truncated before
each test. Created with plain `CREATE DATABASE` rather than the Neon API, so no API key is needed.
`test/setup.ts` refuses to run if the test URL is unset or matches the development one — the suite
truncates every table, so a misconfiguration would destroy the development database rather than
merely fail. Reference data (`Plan`, `AddonPackage`) is deliberately excluded from truncation.

**Transaction-rollback-per-test was rejected**, and the reason is structural rather than aesthetic:
credit consumption opens its own `$transaction`, so a test-owned outer transaction would nest and
rollback would stop meaning what the test expects. Making it work would require threading a
transaction client from the test down through the repository layer — bending production code to
suit the harness. It also cannot express the most important test on that path, since concurrent
consumption needs two connections and a single wrapping transaction forbids that.

**Branch-per-run was rejected for now** — stronger isolation and parallel CI, but needs a Neon API
key and orphans branches on failed teardown. The destination is a local service with no CI.

**Definition of done: a requirement checklist, not a coverage threshold.** Feature-complete is a
claim about requirements, not about lines executed; ninety percent coverage is compatible with
mishandling the 3DS case entirely. Coverage is still measured, as a signal for finding untouched
code.

**Three layers.** Unit (no database, no Stripe) for domain rules. Integration (real test database,
Stripe faked at the adapter seam) for anything involving transactions, constraints, or the webhook
pipeline. Lifecycle (Stripe test clocks, sandbox-only) run deliberately rather than in the standard
suite, because they are rate-limited, capped at two intervals per advance, and auto-deleted after
thirty days.

**Webhook tests construct and sign their own payloads** with the test signing secret — no network,
deterministic, and able to produce the out-of-order sequences §5 requires the processor to tolerate.
`stripe-mock` is unusable (stateless by design) and `stripe trigger` fires cascading real events, so
it serves only as a signature-path smoke test.

Five tests already pass and are recorded in the checklist, covering the non-negative balance
constraint, the one-current-subscription rule, the pending-subscription coexistence case from
ticket 013, and the composite idempotency key from ticket 006.
