## ADDED Requirements

### Requirement: The caller reads their own subscription and wallet
Both reads SHALL be served from the database alone, and no `/v1/me` route SHALL read a user id.

#### Scenario: Answers before Stripe has been reached
- **WHEN** a user whose `BillingCustomer` carries no `stripeCustomerId` calls both routes
- **THEN** both answer 200 with the Free plan, its period, and the granted balances, and a request
  carrying a `userId` property is rejected by the global validation pipe

### Requirement: Subscribing to a paid plan
`POST /v1/me/subscription` SHALL provision defensively and record the subscription as `PENDING`.

#### Scenario: Payment needs authentication
- **WHEN** the named plan's payment requires 3DS
- **THEN** a `PENDING` subscription is recorded, Free stays current, and the wallet is untouched

### Requirement: Changing plan or billing cycle
An upgrade SHALL apply at once with `create_prorations`; a downgrade SHALL be held until renewal.

#### Scenario: Upgrade
- **WHEN** `PATCH /v1/me/subscription` names a costlier plan
- **THEN** Stripe is updated with `create_prorations` and the local plan changes at once

#### Scenario: Downgrade
- **WHEN** `PATCH /v1/me/subscription` names a cheaper plan or the shorter cycle
- **THEN** `pendingPlanId` and `pendingCycle` are written and `planId` does not move

### Requirement: Cancelling and resuming
Cancellation SHALL keep access to period end; Free is not cancellable and an unexpired one resumes.

#### Scenario: Cancelling the Free plan
- **WHEN** the caller's current subscription is Free
- **THEN** `DELETE /v1/me/subscription` is refused with 400 and nothing changes

#### Scenario: Resuming before expiry
- **WHEN** `POST /v1/me/subscription` names the plan a `CANCELED` subscription is on
- **THEN** `cancel_at_period_end` is cleared at Stripe and the subscription returns to `ACTIVE`

### Requirement: Stored payment methods
Only the Stripe reference, brand, last4 and expiry SHALL be stored; the last card SHALL NOT detach.

#### Scenario: The table cannot hold sensitive data
- **WHEN** the `PaymentMethod` columns are enumerated
- **THEN** none can hold a card number or CVC — asserted against the schema, not the writing code

#### Scenario: The last card
- **WHEN** `DELETE /v1/me/payment-methods/:id` names the only method and a paid subscription runs
- **THEN** the request is refused with 400 and Stripe is not called
