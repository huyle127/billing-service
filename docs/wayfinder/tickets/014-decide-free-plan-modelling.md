# 014 Decide Free plan modelling

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

Is a Free subscription a real Stripe subscription at a $0 price, or purely local state?

The requirements say a Stripe Customer is created when the initial Subscription is created,
including the Free one — but never say whether a Stripe **Subscription** exists for Free. Ticket
003 found the two options diverge sharply, and that this choice propagates into the credit
trigger, the period boundary, the Pro→Free transition, and testing.

| | Free = real Stripe subscription at $0 | Free = local-only |
| --- | --- | --- |
| Monthly Free credits | Ride on auto-paid $0 invoices — **unverified, see 015** | Driven by our own cron |
| Period boundary | Stripe owns it | We own it entirely |
| Test clock cost | Drops the per-advance limit to 2 months | No impact |
| Pro→Free transition | Create a Stripe subscription on `customer.subscription.deleted` | Purely local |

Blocked by 015 because the first column rests on an assumption the research could **not** confirm:
whether a $0 recurring price reliably emits a monthly `invoice.paid` for the life of the
subscription. Deciding before that is verified would be building on a guess.

Also to settle:

- If Free is local-only, the Free tier needs its own allocation cron — which merges with the
  annual-subscription cron already in the fog, and changes its scope from "annual subscribers" to
  "annual subscribers plus every Free user". That is a materially larger job.
- If Free is a real Stripe subscription, does a $0 `invoice.paid` produce a `PaymentTransaction`
  row? A payment record for no money moved is probably noise.

## Answer

**Free is a real Stripe subscription at a zero-amount recurring price, and every user gets a Stripe
Customer — including users who never leave Free.** Recorded in requirements §3.

This was decided ahead of ticket 015 rather than after it. That is a deliberate ordering, not an
oversight, but it leaves one thing genuinely unverified: **whether a $0 recurring price emits
`invoice.paid` every month for the life of the subscription.** The design does not depend on the
answer; the *mechanism for monthly Free credits* does. If 015 finds the event does not recur, Free
allocation must be driven by the same cron that serves annual subscriptions. Ticket 015 stays open.

Supporting evidence: the account already contains `price_1TyShMFaNFL0w4nvycCBFDng`, a $0 monthly
price on product `AI Free`, so this matches the catalog that already exists.

**Consequence this decision exposed — a double-allocation bug that was about to be built in.** If
Free is a Stripe subscription, Stripe emits `invoice.paid` with `billing_reason=subscription_create`
for the first $0 invoice, and §6 grants credits on that. Registration also grants the first month's
credits so the dashboard is populated immediately. Both would have fired.

The idempotency key at the time — `(stripeInvoiceId, periodStart)` — could not stop it: the
registration grant carries no invoice, and Postgres treats NULLs as distinct, so both rows would
have been accepted. The key was changed to an opaque **`allocationKey`** identifying the
subscription and the month. It also covers the annual cron, which likewise has no invoice, so the
old key was insufficient regardless of this ticket.

The key is deliberately an opaque string rather than a foreign key to Subscription: the credit
module is a leaf and must not know that subscriptions exist.
