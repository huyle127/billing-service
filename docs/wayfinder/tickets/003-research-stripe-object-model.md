# 003 Research Stripe object model and webhook semantics

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:research -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: research subagent -->
<!-- blocked-by: -->
<!-- output: docs/research/stripe-object-model.md -->

## Question

How do Stripe's objects and events actually map onto the domain model in
`docs/architecture/domain-model.md`, and what exactly do the eight core webhook events guarantee?

Specific questions to answer against Stripe's primary documentation:

- Which Stripe objects correspond to our `Subscription`, `PaymentTransaction`, `PaymentMethod`,
  and `Customer`? Where does Stripe's own subscription status vocabulary (`active`, `past_due`,
  `canceled`, `incomplete`, `unpaid`, `trialing`) differ from ours (`active`, `canceled`,
  `past-due`, `expired`)? Our model has no `incomplete` or `unpaid` — what happens to them?
- For the events listed in requirements §5: what triggers each, what is the payload, and what is
  **not** guaranteed? Specifically: ordering, at-least-once delivery, and duplicate delivery.
- `invoice.paid` drives monthly credit allocation. Does it fire on the first invoice as well as
  renewals? How is a renewal distinguished from an initial payment, and from a proration invoice?
- How is the subscription period boundary (`current_period_end`) exposed, and on which object?
  The annual cron depends on it to stop allocating past the paid period.
- What does Stripe emit during a plan change (Pro to Free, monthly to annual), and where do the
  negative-amount refunds mentioned in requirements §4 come from?
- Webhook signature verification: raw-body requirements and the tolerance window.
- What do Stripe test mode, the CLI's `trigger` command, and test clocks afford for testing
  subscription lifecycles that span months? This directly feeds ticket 010.

## Answer

Full findings: [`docs/research/stripe-object-model.md`](../../research/stripe-object-model.md),
researched against Stripe API version `2026-07-29.dahlia`.

The research answered all eight questions, and in doing so found that **two statements in our own
documents are factually wrong**, not merely imprecise. Headline results:

- **`current_period_end` does not exist on the Subscription object.** Removed in API version
  `2025-03-31.basil`; it now lives on subscription items. The annual-cron rule in requirements
  §"Subscription Credits" names a field that is not there. Basil also moved
  `invoice.subscription` and `invoice.payment_intent`.
- **Stripe does not issue refunds during plan changes.** It issues *proration credits* — negative
  invoice line items and `Customer.balance` entries tracked as `CustomerBalanceTransaction`. The
  negative-amount refund described in requirements §"Payment Transaction" does not occur, and it
  also contradicts §11, which lists refunds as out of scope.
- **Stripe's `canceled` is not our `canceled`.** Ours is Stripe's `active` with
  `cancel_at_period_end=true`; our `expired` is Stripe's `canceled`. A name-to-name mapping is off
  by a full billing period.
- **`invoice.paid` alone is an unsafe credit trigger.** It also fires for proration invoices;
  `billing_reason` is the discriminator and neither of our documents mentions it. Idempotency must
  key on invoice id plus billing period, not only the Stripe event id.
- **Stripe does not guarantee event ordering**, and our requirements never address out-of-order
  arrival. `invoice.paid` can precede the `customer.subscription.updated` that made the
  subscription active.
- **Three Stripe statuses have no home** in our four-value enum: `incomplete`,
  `incomplete_expired`, `unpaid`. The `incomplete` gap is sharpest — SCA/3DS makes it routine, and
  `incomplete_expired` arrives ~23 hours later with no guaranteed event telling us to revoke.
- **Testing:** `stripe-mock` is stateless and unusable for lifecycle tests; `stripe trigger` fires
  cascading real events and suits only signature smoke-testing. Test clocks are the only viable
  option, are sandbox-only, and **cannot fail payments during advancement**. They also move
  Stripe's clock, not ours — so our own cron needs an injectable application clock to be testable.

Seven items were flagged **unconfirmed** rather than guessed. The load-bearing one: whether a $0
recurring price reliably emits monthly `invoice.paid` indefinitely. Free-tier allocation may
depend on it, so it is now ticket 015.

Tickets created from these findings: 012, 013, 014, 015, 016, 017. Tickets 004, 007, and 010 were
amended with constraints this research surfaced.
