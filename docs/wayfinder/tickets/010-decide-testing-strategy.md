# 010 Decide the testing strategy

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: open -->
<!-- assignee: -->
<!-- blocked-by: 001, 003 -->

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

_Unresolved._
