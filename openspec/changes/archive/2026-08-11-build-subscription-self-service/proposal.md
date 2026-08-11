## Why

Implements wayfinder ticket [031](../../../docs/wayfinder/tickets/031-build-subscription-self-service.md).
A user's own subscription, wallet and cards are reachable today only by an admin or through Stripe.

## What Changes

- `GET` `POST` `PATCH` `DELETE /v1/me/subscription` and `GET /v1/me/wallet`; the reads are served from
  the database alone and no `/v1/me` route accepts a user id.
- `GET` `POST` `DELETE /v1/me/payment-methods` and the `payment_method.attached` / `.detached`
  handlers. Only Stripe's reference, brand, last4 and expiry are stored.
- Activating a paid subscription retires the Free one, resetting the wallet before the new allocation.
- An upgrade applies at once with proration; a downgrade is held until renewal, which adds
  `pendingPlanId` and `pendingCycle` to `Subscription`.

## Capabilities

### New Capabilities

- `subscription-self-service`: the `/v1/me` surface — read, subscribe, change, cancel, store a card.

### Modified Capabilities

- `subscription-lifecycle`: a PENDING subscription supersedes the current one; a CANCELED one resumes.
- `webhook-handlers`: renewal applies a held downgrade, and sync leaves the plan alone while one is held.

## Clauses closed

Section 10, already `todo`: `Sensitive payment data never stored locally`. The rest do not exist yet
— the coverage gap the ticket names — so this change adds the rows before satisfying them. Section
4: `A user subscribes to a paid plan for their own account only` · `An upgrade takes effect
immediately with proration` · `A downgrade takes effect at renewal, never mid-cycle` · `A canceled
subscription can be resumed before it expires`. Section 5: `Payment methods are attached and
detached by their owner only` · `The last payment method cannot be detached while a paid
subscription is running` · `payment_method.attached and .detached keep the local references in step`.

## Test budget

10 new tests, the ceiling and not an overrun: Free supersession and the wallet reset, a held
downgrade, renewal applying it, the sync guard, an upgrade's proration, cancel-then-resume, the
last-card refusal, what `PaymentMethod` can hold, `/v1/me` refusing a user id, handler replay.
