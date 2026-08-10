# 028 Build the annual allocation cron and the internal endpoints

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 026 -->

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
- **Never allocate past `paidThroughAt`**, the boundary ticket 026 persists from `invoice.period_end`.
  We own that boundary precisely so this routine does not depend on Stripe being reachable.
- **Time comes from the injected clock (018).** A Stripe test clock moves Stripe's clock, not ours, so
  without the injectable clock neither the catch-up across missed months nor the stop-at-boundary rule
  can be tested at all. This is the ticket that justifies the seam.
- The internal endpoint yields a **service principal with no user identity** and operates on its own
  scope — all subscriptions currently due — never "act on behalf of user X".

## Handed over from ticket 023 (2026-08-06)

This ticket now also ships **`POST /v1/internal/provisioning/run`**, **`InternalKeyGuard`** (timing-safe
comparison against `INTERNAL_API_KEY`, already in configuration) and the **service principal** that
carries no user identifier of any kind — make that unrepresentable in the type rather than rejected
at runtime.

Ticket 023 placed all three. It shipped the provisioning sweep as an in-process schedule instead,
which left the endpoint with no caller of its own, and ticket 020 had already settled the rule that
decides this — **build an operation when a caller exists**, which is why 020 refused to assert the
guard against a probe controller living in a test. Building it here gives the guard **two** real
callers rather than none, and `/v1/internal/provisioning/run` invokes the same `ProvisioningService.sweep()`
the schedule invokes.

## The month arithmetic, settled 2026-08-10 before the build

Ticket 026 shipped `nextCreditAt` as `period.start` with `setUTCMonth(+1)`, which overflows: an annual
term starting 31 January dated the next credit at **3 March**, so February's allocation key was never
minted. Clamping alone would only trade a missing month for a spare one — chaining `+1 month` off each
clamped value drifts backwards (31 → 28 → 28 → …) until the twelfth advance lands *inside*
`paidThroughAt` and a thirteenth month is granted against a term that bought twelve.

The rule is therefore **anchored, not chained**:

- `nextCreditAt(after, paidThrough)` in `src/billing/services/credit-schedule.ts` is the **only** place
  month arithmetic happens. This ticket calls it and computes no dates of its own.
- The anchor day is the day-of-month of **`paidThroughAt`**. No column is added, and 026's write cannot
  disagree with 028's advance — an annual term's start and end share a day-of-month, and where Stripe
  clamps them apart (29 Feb → 28 Feb) `paidThroughAt` is the value both sides can read.
- Keys stay `ALLOCATION_KEYS.month(subscriptionId, at)` and grants stay
  `SubscriptionAllocationService.grantMonth`, both from 026. **This ticket builds neither.** That is
  what keeps one annual-credit mechanism instead of two.
- Proved by `credit-schedule.spec.ts`: a full annual term walks twelve *distinct* keys and the twelfth
  advance lands exactly on `paidThroughAt`, so the `nextCreditAt < paidThroughAt` predicate stops there.

## Answered before the build, 2026-08-10

- **Which subscriptions are due**: `ACTIVE`, plus `CANCELED` still inside `paidThroughAt`. An annual
  term is paid upfront, so cancelling mid-year must not forfeit months already bought — the same rule
  031 states for access. `PENDING` never earns; `PAST_DUE` is unreachable for a term already paid
  through.
- **Catch-up transaction boundary**: one transaction per month — grant month N and advance
  `nextCreditAt` to N+1 together, then repeat. A run that dies after four of eight months keeps the
  four and resumes at the fifth, where one transaction over the whole backlog would hold a wallet lock
  across eight grants and lose all eight to a failure on the last.
- **The service principal is a separate request property**, not a variant of `request.user`.
  `InternalKeyGuard` sets `request.service`, `@CurrentUser()` keeps reading `request.user` and so
  resolves to nothing on an internal route — there is no expression that yields a user id there, which
  is what "unrepresentable in the type" buys. `AuthenticatedUser` and `RolesGuard` are untouched.
- **Both internal routes answer with a count summary**, not `204`. A second run asserting zero grants
  is the ticket's own idempotency claim, and reading it from the response beats counting rows.

## Do not build a claim sweep here

Ticket 023's `FOR UPDATE SKIP LOCKED` lease exists because provisioning calls Stripe and must not hold
locks across the network. **This routine touches no network**, so it needs none of that: the wallet
lock inside `CreditService.allocate` serialises concurrent runs, and the duplicate is answered by
`findAllocation` on the month key, which replays instead of granting. Two runs racing one subscription
converge — they compute the same `nextCreditAt` from the same anchor and write the same value. Copying
023's claim-then-work shape by analogy would add a lease with nothing to protect.

## Requirement clauses closed

Section 3:

- Cron allocates monthly for annual subscriptions
- Cron catches up one month at a time across missed periods
- Cron never allocates past the paid-through boundary

Section 9, inherited from ticket 020 by way of 023:

- Internal key yields a service principal with no user identity
- Internal endpoints reject "act on behalf of" semantics
