# 026 Build the webhook handlers: subscriptions, invoices, and the ordering guarantees

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/webhook/handlers/ -->
<!-- blocked-by: 022, 024, 025 -->

## Question

Handlers for `customer.subscription.created` / `.updated` / `.deleted`, `customer.created` /
`.updated`, `invoice.paid` and `invoice.payment_failed`. `payment_method.*` is ticket 031.

**Merged from the old ticket 027 on 2026-08-10.** The two were split by Stripe object — subscription
events here, invoice events there — but they share one processor, one set of ordering guards, and one
proving test. The convergence test below is the reason: a real event history is
`created → paid → payment_failed → paid → deleted`, so replaying it with only the subscription
handlers built exercises half the machine and the invoice half would have to repeat the test from
scratch. Split by Stripe object, the seam runs across the guarantee rather than around it.

## The ordering guarantees

Every rule here exists because Stripe gives **no ordering guarantee**, and the processor must
converge regardless. This is where ticket 017's design becomes code.

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

## The invoice path, where a silent bug costs money

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
- **Allocate through the owner ticket 025 built**, never by calling `credit.allocate` directly. It
  already carries the subscription-plus-month key (022), which is what makes the registration grant
  and the first zero-amount `invoice.paid` collapse into a single grant.
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
- `invoice.payment_failed` drives the past-due transition. Ticket 025 built the wallet freeze **inside**
  that transition, so this handler never calls `credit.freeze` itself. Both ledgers stop being
  consumable; add-on balances are untouched.
- **Recovery is driven by observing a successful payment**, not by Stripe returning the subscription to
  a particular status — Stripe's own past-due transition behaviour is a Dashboard setting that cannot
  be read at runtime. On resolution: unfreeze and allocate the next period.
- **A past-due subscription that expires leaves the wallet frozen.** 025 shipped the unfreeze only on
  `PAST_DUE → ACTIVE`, because that is the edge its spec names. `PAST_DUE → EXPIRED` therefore
  downgrades to Free with a `FROZEN` wallet and nothing to thaw it — the next Free grant would land
  in a wallet that cannot be spent. Decide here whether the unfreeze belongs on every edge leaving
  `PAST_DUE` or only on the downgrade, and close it in the transition, not in a handler.

## The test that proves the rest

Replay the full event history in shuffled order — subscription **and** invoice events, including
duplicates interleaved with newer events — and assert it converges on the same result as ordered
processing. Webhook tests construct and sign their own payloads (010), so sequences Stripe would
rarely emit are cheap to produce here. If that test passes, the ordering clauses are real; if it only
passes in order, one of the guards above is missing.

**This ticket does not fit one OpenSpec change under the ten-test ceiling.** It closes eleven clauses
across two requirement sections. Prefer splitting it at propose time — the ordering guards and the
subscription handlers first, the invoice path second — and let the second change extend the
convergence test rather than write its own. Arguing the budget up in one proposal is the map's other
sanctioned route, but it puts the money path and the ordering guards in one review.

## Inherited from the 2026-08-10 audit

**Delete `SubscriptionTrialWillEndHandler` as part of this ticket.** Ticket 024 shipped it as a
no-op purely to prove the dispatch path, and it handles `customer.subscription.trial_will_end` —
a trial system requirements §11 puts out of scope, so it will never grow a body. It reads to any
newcomer as evidence this service supports trials.

It was **not** deleted when the audit found it, deliberately. It is the only member of
`WEBHOOK_EVENT_TYPES`, so removing it collapses `WebhookEventType` to `never` and no handler can
satisfy the abstract class; it is also the DI slot `test/webhook-http.spec.ts` overrides with its
`ProgrammableHandler`, and the `webhook-pipeline` spec requires that an event reach the handler
claiming its type. Deleting it early would mean building replacement scaffolding with no caller —
the same rule that condemns the handler. This ticket is where real handlers make the union
non-empty for real reasons, so the removal is free here and costly anywhere else.

## Requirement clauses closed

Section 5:

- Processing never assumes event ordering
- Handlers re-fetch the object rather than trusting the payload
- Period-derived state advances monotonically
- An event whose subject is missing defers rather than failing
- Replaying full history converges on the ordered result
- Webhooks never create domain rows

Section 6:

- Payment detected via `invoice.status`, never the removed `paid` field
- Allocation grants on `subscription_create`, `_cycle`, and `_update` only
- Free tier allocates monthly from `invoice.paid` with no separate cron
- A mid-cycle plan change grants a full new monthly allocation
- Resolving past due unfreezes and allocates the next period

Testing note: a Stripe test clock **cannot fail a payment during advancement**, so the past-due
scenarios need a declining test card attached before the clock advances. Test clocks are also
sandbox-only, rate limited to twenty invoices per subscription per day, and capped at two intervals
per advance — so these are lifecycle tests run deliberately, not part of the standard suite.
