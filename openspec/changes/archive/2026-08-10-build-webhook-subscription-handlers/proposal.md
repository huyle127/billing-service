## Why

Ticket [026 Build the webhook handlers](../../../docs/wayfinder/tickets/026-build-webhook-handlers.md)
is where ticket 017's out-of-order design becomes code: ticket 024 shipped the pipeline with one
no-op handler, so no Stripe event changes a Subscription today. **Split as the ticket asks** — the
guards and the subscription and customer handlers here, the invoice path in a second change that
extends this one's convergence test rather than writing its own.

## What Changes

- The handler contract splits into a re-fetch phase running before the transaction opens and an
  apply phase inside it. **BREAKING** for `WebhookHandler`; its one implementation,
  `SubscriptionTrialWillEndHandler`, is deleted here.
- `customer.subscription.created` attaches by `metadata.subscriptionId`, **deferring when no local
  row matches** rather than creating one.
- `customer.subscription.updated` syncs `stripeStatus` and `stripePriceId`, re-points `planId` when
  the price changed, and drives the `cancel` transition on `cancel_at_period_end`.
- `customer.subscription.deleted` drives the `expire` transition; `customer.created` attaches
  `stripeCustomerId`; **`customer.updated` waits for ticket 031** to give it a body.
- A stale event cannot regress period-derived state, guarded by a new `Subscription.stripePeriodEnd`.
- The wallet unfreezes on **every** edge leaving `PAST_DUE`, not only on `PAST_DUE → ACTIVE`.
- The account's post-dunning setting is fixed to `Cancel subscription` and recorded in ticket 002.

## Capabilities

### New Capabilities
- `webhook-handlers`: what a handler does with an event — re-fetch, guard, attach, defer, transition.

### Modified Capabilities
- `subscription-lifecycle`: unfreeze is keyed on leaving `PAST_DUE`, not on arriving at `ACTIVE`.
  `webhook-pipeline` is untouched — the resolve/apply split changes no scenario it owns.

## Impact

- `src/billing/webhook/`, `subscription-lifecycle.service.ts`, a migration for `stripePeriodEnd`.
- Clauses moved off `todo` in `docs/testing/requirement-coverage.md` Section 5, verbatim:
  "Processing never assumes event ordering" · "Handlers re-fetch the object rather than trusting the
  payload" · "Period-derived state advances monotonically" · "An event whose subject is missing
  defers rather than failing" (today `partial`) · "Webhooks never create domain rows". "Replaying
  full history converges on the ordered result" waits for the invoice change to extend the test.
  **Test budget: 8 new tests**, under the ceiling of 10.
