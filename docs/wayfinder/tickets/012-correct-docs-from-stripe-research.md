# 012 Correct the requirements and domain model from Stripe research

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

Ticket 003 found statements in our own documents that are factually wrong about Stripe. Correct
them, so that every downstream design ticket works from an accurate source.

Corrections required in `docs/requirements/billing-service-requirements.md` and
`docs/architecture/domain-model.md`:

- **`current_period_end`.** Requirements §"Subscription Credits" says the cron stops allocating
  once it reaches the Subscription's `current_period_end`. That field was removed from the Stripe
  Subscription object in API version `2025-03-31.basil`. Restate it in terms of a paid-through
  boundary we own, without naming a Stripe field that no longer exists there.
- **The refund assumption.** Requirements §"Payment Transaction" states that refunds initiated by
  Stripe during plan changes are recorded as negative-amount transactions. Stripe issues proration
  *credits*, not refunds. Remove or restate this. Note it also contradicts §11, which lists refund
  workflow as out of scope — resolve that contradiction rather than leaving both statements.
- **`canceled` versus `expired`.** `domain-model.md` says `expired` is triggered by Stripe webhook
  confirmation but never says how `canceled` is detected, and the obvious reading is wrong.
  Document the actual correspondence once ticket 013 decides it.

This ticket is deliberately **mechanical** — it records decisions made elsewhere. Anything
requiring a judgement call belongs in 013, 014, or 016, not here. If 013 has not resolved yet,
correct the two factual errors now and leave the status wording to a second pass.

## Answer

All three corrections applied to `docs/requirements/billing-service-requirements.md` and
`docs/architecture/domain-model.md`.

- **`current_period_end`** — the cron rule now refers to a paid-through boundary that the Billing
  Service owns and persists from `invoice.period_end`, rather than naming a Stripe Subscription
  field that no longer exists. Owning it locally also decouples the cron from Stripe availability.
- **The refund assumption** — removed. The Payment Transaction section now states that Stripe
  issues proration credits (`CustomerBalanceTransaction`), not refunds, that no `Refund` object
  exists unless we create one, and that proration credits are never recorded as negative-amount
  payments. This also resolves the contradiction with §11.
- **`canceled` versus `expired`** — resolved by ticket 013, whose mapping table is now in the
  requirements under Subscription, with the detection rules mirrored in the domain model.
