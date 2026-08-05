# 028 Build the annual allocation cron and the internal endpoints

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 027 -->

## Question

Annual subscriptions are paid once upfront but earn credits monthly. This is the routine that grants
them.

- **One idempotent routine, two triggers**: an in-process schedule and
  `POST /v1/internal/allocations/run` behind the internal API key. Ticket 009 graduated the
  cron-versus-scheduler question out of the fog by refusing to choose — both invoke the same routine,
  so the service runs locally with no external scheduling infrastructure while an external scheduler
  can drive it later without a logic change. This is also why `INTERNAL_API_KEY` exists.
- **Running both simultaneously is harmless.** The allocation key makes a duplicate run allocate
  nothing. Assert that, rather than serialising the two triggers.
- Query active annual subscriptions where `nextCreditAt < now`, using the existing
  `@@index([status, nextCreditAt])`. Allocate the plan's monthly credits, record the
  `CreditTransaction`, advance `nextCreditAt` by one month.
- **Catch up one month at a time.** Each missed period is its own `CreditTransaction` under its own
  month's allocation key — never one lump sum, which would be unauditable and would collide with the
  key scheme.
- **Never allocate past `paidThroughAt`**, the boundary ticket 027 persists from `invoice.period_end`.
  We own that boundary precisely so this routine does not depend on Stripe being reachable.
- **Time comes from the injected clock (018).** A Stripe test clock moves Stripe's clock, not ours, so
  without the injectable clock neither the catch-up across missed months nor the stop-at-boundary rule
  can be tested at all. This is the ticket that justifies the seam.
- The internal endpoint yields a **service principal with no user identity** and operates on its own
  scope — all subscriptions currently due — never "act on behalf of user X".

## Requirement clauses closed

Section 3:

- Cron allocates monthly for annual subscriptions
- Cron catches up one month at a time across missed periods
- Cron never allocates past the paid-through boundary
