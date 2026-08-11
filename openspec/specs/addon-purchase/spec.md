# addon-purchase

## Purpose

Buying a fixed credit package outright, the one path that grants credits with no subscription behind
it. The request takes the money and records the attempt; the credits are handed over only by the
`payment_intent.succeeded` webhook, never by the request that started the charge. Add-on credits then
behave as the ledger already says: they never expire, never reset, survive a freeze, and are drawn
only once subscription credits are gone. Refunds are out of scope, so a purchase is final.

## Requirements

### Requirement: Buying a credit package
`POST /v1/me/addons/purchase` SHALL name an active package by code, act on the caller's own wallet
only, provision the Stripe customer defensively, and charge the caller's default stored card.

#### Scenario: The package must be on the public catalog
- **WHEN** the body names a code no `AddonPackage` carries, or one whose row is `active: false`
- **THEN** the request is refused with 404 and no `PaymentTransaction` row is written

#### Scenario: No stored card
- **WHEN** the caller holds no attached payment method
- **THEN** the request is refused with 400 and Stripe is not called

### Requirement: The purchase is recorded before the money is taken
A `PaymentTransaction` SHALL be written `PENDING` with `kind: ADDON` and its `addonPackageId` before
`createOneTimePayment` is called, and its id SHALL be the `purchaseId` the PaymentIntent is keyed on.

#### Scenario: The request path grants nothing
- **WHEN** a purchase is made and Stripe confirms the intent `succeeded` in that same call
- **THEN** both credit balances are unchanged, the payment row is still `PENDING`, and the wallet
  holds no `ALLOCATION` for that purchase

#### Scenario: Authentication is a resting state
- **WHEN** Stripe answers `requires_action`
- **THEN** the payment row stays `PENDING`, the response reports that status, and nothing is granted

### Requirement: A frozen wallet cannot buy add-on credits
A purchase SHALL be refused while the caller's wallet is `FROZEN`, before Stripe is called.

#### Scenario: Past due
- **WHEN** a caller whose subscription is `PAST_DUE` purchases a package
- **THEN** the request is refused with 400, no payment row is written, and no intent is created

### Requirement: One intent backs at most one payment row
`PaymentTransaction.stripePaymentIntentId` SHALL be unique.

#### Scenario: A second row claiming the same intent
- **WHEN** a payment row is written carrying an intent id another row already holds
- **THEN** the write is refused by the unique index, not by the writing code
