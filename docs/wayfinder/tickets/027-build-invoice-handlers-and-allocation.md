# 027 Build the invoice webhook handlers and the credit allocation triggers

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/webhook/handlers/ -->
<!-- blocked-by: 024, 025, 022 -->

## Question

Handlers for `invoice.paid` and `invoice.payment_failed` — the path that grants value, and therefore
the one where a silent bug costs money.

- **Detect payment with `invoice.status === 'paid'`.** The Invoice `paid` boolean was removed and now
  reads `undefined`, which is falsy — `if (invoice.paid)` would compile, pass review, and silently
  never allocate credits. Ticket 015 found this against a live test clock. The **event type**
  `invoice.paid` is unaffected and still fires; it is the field that is gone.
- **Allocate only on `billing_reason` of `subscription_create`, `subscription_cycle`, or
  `subscription_update`.** `manual`, `subscription_threshold`, and everything else allocate nothing.
  Ticket 016 decided this: `invoice.paid` alone cannot tell you whether credits are owed.
- **A mid-cycle plan change granting a full new monthly allocation is an intentional business rule,
  not a defect.** The upgrade is treated as the start of entitlement to the new plan. Credits are
  never prorated; only money is, and Stripe handles that independently.
- Pass the subscription-plus-month allocation key (022). It is what makes the registration grant and
  the first zero-amount `invoice.paid` collapse into a single grant.
- **Free tier rides this same path.** Ticket 015 confirmed empirically that a $0 recurring price
  produces one invoice per month indefinitely and emits `invoice.paid` each time —
  `subscription_create` on the first, `subscription_cycle` thereafter. **No separate Free scheduler
  exists and none is needed.**
- **Persist the paid-through boundary** from `invoice.period_end` on every processed `invoice.paid`.
  We own it. It is deliberately not read from a Stripe Subscription field at allocation time —
  `current_period_end` no longer lives there — and owning it locally keeps the cron (028) independent
  of Stripe availability.
- Record a `PaymentTransaction` — **but never for a zero-amount invoice.** No money moved, so there is
  no money event to record.
- **One transaction or none.** Activation, allocation, the payment record and the `SubscriptionEvent`
  land together. Requirements §5 demands atomicity at the Subscription aggregate level, and
  [`architecture.md`](../../architecture/architecture.md) diagrams this exact flow. The Stripe
  re-fetch happens before it opens.
- `invoice.payment_failed` → `PAST_DUE` and **freeze the wallet**. Both ledgers stop being consumable;
  add-on balances are untouched.
- **Recovery is driven by observing a successful payment**, not by Stripe returning the subscription to
  a particular status — Stripe's own past-due transition behaviour is a Dashboard setting that cannot
  be read at runtime. On resolution: unfreeze and allocate the next period.

## Requirement clauses closed

Section 6:

- Payment detected via `invoice.status`, never the removed `paid` field
- Allocation grants on `subscription_create`, `_cycle`, and `_update` only
- Free tier allocates monthly from `invoice.paid` with no separate cron
- A mid-cycle plan change grants a full new monthly allocation
- Wallet freezes when a subscription goes past due
- Resolving past due unfreezes and allocates the next period

Testing note: a Stripe test clock **cannot fail a payment during advancement**, so the past-due
scenarios need a declining test card attached before the clock advances. Test clocks are also
sandbox-only, rate limited to twenty invoices per subscription per day, and capped at two intervals
per advance — so these are lifecycle tests run deliberately, not part of the standard suite.
