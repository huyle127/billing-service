# 016 Decide the credit allocation trigger and idempotency key

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

Exactly which Stripe signal grants subscription credits, and what key makes that grant idempotent?

Both existing documents say credits are allocated "when Stripe emits `invoice.paid`". Ticket 003
established that this rule as written **over-allocates**.

Failure modes to design against:

1. **Plan change over-allocation.** A mid-cycle upgrade with `proration_behavior=always_invoice`
   emits `invoice.paid` with `billing_reason=subscription_update` — granting a full extra month of
   credits. The discriminator is `billing_reason` (`subscription_create` / `subscription_cycle` /
   `subscription_update`), which neither document mentions.
2. **Duplicate delivery.** Idempotency by `event.id` (which requirements §5 does specify) catches
   exact replays but **not two distinct events for the same invoice**. The research recommends the
   allocation key be **invoice id plus billing period**, not the Stripe event id. Note this is a
   different key from the `WebhookEvent` table's ingestion-level idempotency — both are needed, at
   different layers.
3. **Zero-amount invoices** are auto-marked paid and emit `invoice.paid` with no money moved.
   Whether that should grant credits depends on ticket 014.

Questions to resolve:

- Which `billing_reason` values grant credits, and how many months' worth?
- What is the allocation idempotency key, and where is it enforced — a unique constraint, or
  application logic? A unique constraint is the only thing that survives concurrent processing.
- On an upgrade mid-period, does the user get the difference, a full new allocation, or nothing
  until the next cycle? The requirements do not say, and this is a product decision.
- How does this interact with the annual cron, which allocates monthly without any invoice?

Blocked by 014 because whether Free rides on `invoice.paid` at all changes the answer.

## Answer

Recorded in requirements §6 under **Credit Allocation Triggers**.

- **Which `billing_reason` values grant credits:** `subscription_create`, `subscription_cycle`,
  and `subscription_update`. Everything else (`manual`, `subscription_threshold`, others) grants
  nothing.
- **Mid-cycle plan change grants a full monthly allocation of the new plan.** The research
  reported this as an over-allocation defect; it is not. It is a deliberate product decision —
  the upgrade starts entitlement to the new plan, credits are not prorated, and only money is.
  Documented explicitly so it is not "fixed" later by someone reading it as a bug.
- **Allocation idempotency key is invoice ID plus billing period**, enforced by a uniqueness
  constraint on the Credit Transaction, not by application logic. Application-level checks do not
  survive concurrent processing. This is a second layer, distinct from the `WebhookEvent`
  idempotency on Stripe event ID: the first stops the same event processing twice, the second
  stops two *distinct* events granting the same credits twice.
- **Zero-amount invoices** record no Payment Transaction. Whether they carry Free-tier allocation
  depends on ticket 014 and is marked as undecided in the requirements rather than assumed.

Unblocked from 014: the Free-tier question was the only dependency, and it is now recorded as an
open branch in the requirements rather than blocking the rest of the rule.

Carried forward, not answered here: **how allocation interacts with the annual cron**, which
allocates monthly with no invoice and therefore has no invoice ID to key on. That belongs with the
cron mechanism, still in the map's fog.
