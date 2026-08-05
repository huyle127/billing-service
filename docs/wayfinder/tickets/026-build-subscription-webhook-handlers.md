# 026 Build the subscription webhook handlers and the ordering guarantees

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/webhook/handlers/ -->
<!-- blocked-by: 024, 025 -->

## Question

Handlers for `customer.subscription.created` / `.updated` / `.deleted`, and `customer.created` /
`.updated`. Invoice handlers are ticket 027; `payment_method.*` is ticket 031.

This is where ticket 017's design becomes code. Every rule below exists because Stripe gives **no
ordering guarantee**, and the processor must converge regardless.

- **Re-fetch, never trust the payload.** The handler fetches the affected object from Stripe and
  applies current state. The payload is a notification that something changed, not the authority on
  what it changed to — this is Stripe's own documented mitigation for out-of-order delivery.
  **The re-fetch happens before the transaction opens**; no network call ever runs inside one, or a
  slow Stripe response becomes a service-wide stall while row locks are held.
- **Monotonic guard.** Period-derived state only ever advances, so a late stale event cannot regress a
  subscription. The version marker is the subscription **item's** period end — ticket 015 confirmed
  directly that period fields live on the item, not on the Subscription object, which is the change
  `2025-03-31.basil` made.
- **Defer, do not create.** `customer.subscription.created` matches on `metadata.subscriptionId`:
  - match found with no Stripe id recorded → **attach**: write `stripeSubscriptionId`, clear sync state
  - match found, already attached → no-op
  - **no match → defer**, using the deferral outcome from 024

  Creating a row on a missed match would produce two subscriptions for one user and violate the
  one-current-subscription index. Stripe can deliver the event before our own `subscriptions.create`
  response has been persisted, so this race is normal, not exceptional.
- **Webhooks never create domain rows. They attach and update.** Every Subscription originates from
  our own flow.
- Attachment racing the reconciler (023) is safe by construction: both write the same value, the
  unique constraint admits one, and the loser's retry finds the work already done.
- Transitions go through the state machine (025), never by writing `status` directly.

**The test that proves the rest.** Replay the full event history in shuffled order — including
duplicates interleaved with newer events — and assert it converges on the same result as ordered
processing. Webhook tests construct and sign their own payloads (010), so sequences Stripe would
rarely emit are cheap to produce here. If that test passes, the other five clauses are real; if it
only passes in order, one of the guards above is missing.

## Requirement clauses closed

Section 5:

- Processing never assumes event ordering
- Handlers re-fetch the object rather than trusting the payload
- Period-derived state advances monotonically
- An event whose subject is missing defers rather than failing
- Replaying full history converges on the ordered result
- Webhooks never create domain rows
