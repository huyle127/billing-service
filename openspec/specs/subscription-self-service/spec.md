# subscription-self-service

## Purpose

The `/v1/me` surface a user's own dashboard drives: reading their subscription and wallet, moving off
Free, changing plan or billing cycle, cancelling, resuming, and storing a card. Every route here acts
on the token holder and never accepts a user id — another user's data is reachable only through the
admin surface. The two reads are answered from the database alone, so they work the moment
registration commits rather than waiting on Stripe having been reached.

## Requirements

### Requirement: The caller reads their own subscription and wallet

`GET /v1/me/subscription` and `GET /v1/me/wallet` SHALL be served from the database alone, reaching
no network. No `/v1/me` route SHALL read a user id from a body, query or path; a body carrying one is
refused by the global validation pipe rather than ignored, because a silently ignored `userId` reads
to the caller as an accepted instruction.

#### Scenario: Answers before Stripe has been reached
- **WHEN** a user whose `BillingCustomer` carries no `stripeCustomerId` calls both routes
- **THEN** both answer 200 with the Free plan, its period, and the granted balances

#### Scenario: A body carrying a user id
- **WHEN** any `/v1/me` request carries a `userId` property
- **THEN** the request is refused with 400

### Requirement: Subscribing to a paid plan

`POST /v1/me/subscription` SHALL ensure the Stripe Customer defensively, record the new subscription
as `PENDING`, and leave the caller on Free until payment confirms. The subscription becomes current
only through the activation path, which is where the Free row it replaces is retired. A caller
already on a paid plan SHALL be refused and directed to `PATCH`.

#### Scenario: Payment needs authentication
- **WHEN** the named plan's payment requires 3DS
- **THEN** a `PENDING` subscription is recorded, Free stays current, and the wallet is untouched

### Requirement: Changing plan or billing cycle

`PATCH /v1/me/subscription` SHALL apply an upgrade immediately with `create_prorations`, and SHALL
hold a downgrade — a cheaper plan, or the shorter cycle — on `pendingPlanId` and `pendingCycle` until
the next renewal applies it. The cheaper price is pushed to Stripe at once with no proration, so the
renewal bills the new amount while the current period stays paid; `planId` does not move, because
entitlement is ours and the subscriber has already bought this period's credits. A subscription
holding a pending change SHALL be invisible to the catalog price reconciler, which would otherwise
read the deliberate price mismatch as drift and migrate it back.

#### Scenario: Upgrade
- **WHEN** `PATCH /v1/me/subscription` names a costlier plan
- **THEN** Stripe is updated with `create_prorations` and the local plan changes at once

#### Scenario: Downgrade
- **WHEN** `PATCH /v1/me/subscription` names a cheaper plan or the shorter cycle
- **THEN** `pendingPlanId` and `pendingCycle` are written, `planId` does not move, and exactly one
  current subscription remains

### Requirement: Cancelling and resuming

`DELETE /v1/me/subscription` SHALL cancel at period end, keeping access and credits until then, and
SHALL clear any held plan change. The Free plan SHALL NOT be cancellable — there is nothing to cancel
and the account would be left with no subscription at all. A `CANCELED` subscription that has not yet
expired SHALL be resumable by `POST` naming the plan it is already on.

#### Scenario: Cancelling the Free plan
- **WHEN** the caller's current subscription is Free
- **THEN** `DELETE /v1/me/subscription` is refused with 400 and nothing changes

#### Scenario: Resuming before expiry
- **WHEN** `POST /v1/me/subscription` names the plan a `CANCELED` subscription is on
- **THEN** `cancel_at_period_end` is cleared at Stripe and the subscription returns to `ACTIVE`

### Requirement: Stored payment methods

Only Stripe's reference, brand, last4 and expiry month and year SHALL be stored — never a card
number, never a CVC. The first card attached becomes the default. `DELETE /v1/me/payment-methods/:id`
SHALL refuse to detach the last one while a paid subscription is `ACTIVE` or `PAST_DUE`, because
doing so guarantees the next renewal fails and freezes the wallet; Free has nothing to renew, so the
refusal reads the subscription's status rather than merely its existence.

#### Scenario: The table cannot hold sensitive data
- **WHEN** the `PaymentMethod` table's columns are enumerated
- **THEN** none can hold a card number or a CVC — asserted against the schema, not against the code
  that writes to it

#### Scenario: The last card
- **WHEN** `DELETE /v1/me/payment-methods/:id` names the caller's only payment method and a paid
  subscription is running
- **THEN** the request is refused with 400 carrying `PAYMENT_METHOD_REQUIRED`, and Stripe is not
  called
