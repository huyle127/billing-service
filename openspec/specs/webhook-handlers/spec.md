# webhook-handlers Specification

## Purpose
TBD - created by archiving change build-webhook-subscription-handlers. Update Purpose after archive.
## Requirements
### Requirement: A handler applies re-fetched state, never the payload

A handler SHALL retrieve its subject from Stripe before its transaction opens, and SHALL apply that
retrieved state. No network call SHALL run inside the transaction.

#### Scenario: The payload disagrees with Stripe
- **WHEN** an event is processed whose payload carries a price and period the Stripe object no
  longer holds
- **THEN** the row reflects what Stripe returned, not what the payload carried

### Requirement: An event whose subject has no local row defers

A handler SHALL match `customer.subscription.*` on `metadata.subscriptionId` and `customer.*` on
`metadata.userId`, and SHALL defer an event that matches nothing. A webhook SHALL never insert a
`Subscription`, `BillingCustomer`, or `User`.

#### Scenario: A subscription Stripe knows and we do not
- **WHEN** `customer.subscription.created` names a `subscriptionId` no local row carries
- **THEN** the outcome is a deferral and the `Subscription` row count is unchanged

### Requirement: Attachment writes the Stripe id once

A handler SHALL write `stripeSubscriptionId` or `stripeCustomerId` onto the matched row and clear its
sync state, and a repeat SHALL change nothing further.

#### Scenario: The created event arrives twice
- **WHEN** `customer.subscription.created` is delivered a second time
- **THEN** the id is unchanged, `syncAttempts` is zero, `syncError` is null, and one row exists

### Requirement: Period-derived state only advances

A handler SHALL compare the retrieved subscription item's period end against the stored
`stripePeriodEnd` and SHALL apply nothing when the retrieved value is the older one.

#### Scenario: A late event carrying a superseded period
- **WHEN** an event resolves to a period end earlier than the stored `stripePeriodEnd`
- **THEN** status, `planId`, `stripePriceId` and `stripePeriodEnd` are all left as they were

### Requirement: Stripe-side lifecycle changes drive our transitions

A handler SHALL request `cancel` when the retrieved subscription carries `cancel_at_period_end`,
`expire` on `customer.subscription.deleted`, and SHALL re-point `planId` to the plan holding the
retrieved price. It SHALL reach status only through the transition table, never by writing `status`.

#### Scenario: Cancellation from the Stripe Dashboard
- **WHEN** `customer.subscription.updated` resolves to `cancel_at_period_end`
- **THEN** the row reads `CANCELED`, stays current, and the credit balance is unchanged

#### Scenario: A plan change seen from Stripe
- **WHEN** `customer.subscription.updated` resolves to a price belonging to another plan
- **THEN** `planId` names that plan and no `ALLOCATION` transaction is written

### Requirement: Replay in any order converges

Processing the subscription event history in any order, with duplicates, SHALL leave the same rows
as processing it in the order Stripe generated it.

#### Scenario: A shuffled history with duplicates
- **WHEN** the same events are replayed shuffled against a second identical user
- **THEN** both users' subscription status, `planId`, `stripePeriodEnd` and credit balances match

### Requirement: Payment is read from the invoice status

A handler SHALL treat an invoice as paid only when its `status` reads `paid`, and SHALL NOT read the
removed `paid` boolean.

#### Scenario: An invoice event arrives unpaid
- **WHEN** `invoice.paid` resolves to an invoice whose status is not `paid`
- **THEN** no `ALLOCATION` and no `PaymentTransaction` are written

### Requirement: Only three billing reasons owe credits

A handler SHALL grant credits when the invoice's `billing_reason` is `subscription_create`,
`subscription_cycle` or `subscription_update`, and nothing for any other reason.

#### Scenario: A manual invoice is paid
- **WHEN** a paid invoice carries `billing_reason` of `manual`
- **THEN** no `ALLOCATION` is written, while one carrying `subscription_cycle` for the same
  subscription grants the plan's monthly credits

### Requirement: A grant is keyed on the invoice period, not the processing time

A handler SHALL derive the allocation key from the invoice's `period_start`, so the same invoice
grants once however late or however often it is delivered.

#### Scenario: A paid invoice is redelivered in a later month
- **WHEN** the same paid invoice is processed twice, the second time after the clock has moved into
  the next month
- **THEN** exactly one `ALLOCATION` exists for that subscription and period

### Requirement: The paid-through boundary and the annual credit date are ours

A handler SHALL write `paidThroughAt` from the invoice's `period_end` on every paid invoice, and
`nextCreditAt` one month past its `period_start` for an annual subscription only.

#### Scenario: An annual subscription is paid
- **WHEN** a paid invoice for an annual subscription is processed
- **THEN** `paidThroughAt` is the invoice's period end and `nextCreditAt` is one month past its
  period start, while the same flow on a monthly subscription leaves `nextCreditAt` unset

### Requirement: One payment record per invoice, and none for a zero-amount one

A handler SHALL record a `PaymentTransaction` against the invoice, `FAILED` on a failed payment and
`SUCCEEDED` on a paid one, at most one row per invoice because `stripeInvoiceId` is unique, and
nothing at all for an invoice of zero amount.

#### Scenario: A payment fails and the retry succeeds
- **WHEN** `invoice.payment_failed` is followed by `invoice.paid` for the same invoice
- **THEN** exactly one `PaymentTransaction` exists for it, reading `SUCCEEDED`, and the unique
  `stripeInvoiceId` constraint rejects any attempt to insert a second

#### Scenario: The Free plan's monthly invoice
- **WHEN** a paid invoice of zero amount is processed
- **THEN** the plan's monthly credits are granted and no `PaymentTransaction` is written

### Requirement: A failed payment moves the subscription past due

A handler SHALL drive the past-due transition on `invoice.payment_failed` and the renew transition on
`invoice.paid`, reaching status only through the transition table. Where that transition answers
`unchanged`, no part of the invoice SHALL be applied — no grant, no boundary, no payment record.

#### Scenario: Dunning and recovery
- **WHEN** a renewal payment fails and a later payment for it succeeds
- **THEN** the subscription reads `PAST_DUE` then `ACTIVE`, the wallet is frozen then thawed, and the
  recovering payment grants its period's credits

#### Scenario: An invoice arriving after the subscription has expired
- **WHEN** a paid invoice is processed against an already-expired subscription
- **THEN** no `ALLOCATION` and no `PaymentTransaction` are written

### Requirement: A held downgrade lands at renewal and nowhere else

A paid renewal SHALL apply `pendingPlanId` and `pendingCycle` and then clear both, before credits are
granted and before the paid-through boundary is written, so the grant and the cycle-dependent credit
date both read the plan the subscriber is moving onto. Subscription sync SHALL NOT write `planId`
from a retrieved price while that price belongs to the subscription's pending plan — without that
guard, the `customer.subscription.updated` which the downgrade's own Stripe call emits would apply
the change immediately and take away a period the subscriber has paid for.

#### Scenario: The renewal grants the new plan's credits
- **WHEN** a renewal invoice is paid for a subscription holding a pending downgrade
- **THEN** `planId` and `cycle` take the pending values, both pending columns are cleared, and the
  allocation is the new plan's monthly credits

#### Scenario: The update event a downgrade emits
- **WHEN** `customer.subscription.updated` arrives carrying the downgraded price
- **THEN** `stripePriceId` and `stripeStatus` are written and `planId` is left unchanged

### Requirement: Payment method events keep the local references in step

`payment_method.attached` SHALL re-fetch the payment method, resolve its Stripe customer to a local
user, and record the reference; `payment_method.detached` SHALL mark the local row detached. Both
SHALL be idempotent under redelivery, and a repeat attach SHALL NOT rewrite `isDefault` — recomputing
it on replay would count the stored row itself and strip the subscriber's default card.

#### Scenario: A redelivered attach and a redelivered detach
- **WHEN** each event is processed twice for the same payment method
- **THEN** exactly one `PaymentMethod` row exists, holding its default flag, and after the detach it
  carries a `detachedAt`

### Requirement: Add-on credits are granted by the payment intent, and only when it succeeds

`payment_intent.succeeded` SHALL grant the package's credits to the `ADDON` ledger and settle the
purchase's payment row to `SUCCEEDED` in one transaction, keyed on the purchase id.

#### Scenario: Success grants and records together
- **WHEN** `payment_intent.succeeded` resolves to a `PENDING` add-on purchase
- **THEN** the add-on balance rises by the package's credits and the payment row reads `SUCCEEDED`,
  both written by that one event

#### Scenario: Two purchases of one package
- **WHEN** a user buys the same package twice and both intents succeed
- **THEN** both grants land, because the key is the purchase and not the package

### Requirement: A redelivered intent grants once

A purchase that has left `PENDING` SHALL complete without work, and a concurrent second grant SHALL
be refused by the `CreditTransaction` key rather than by the handler.

#### Scenario: Redelivery
- **WHEN** `payment_intent.succeeded` is delivered again for a purchase already settled
- **THEN** the balance does not move, exactly one `ALLOCATION` row exists for that purchase, and the
  event completes

### Requirement: A failed intent grants nothing

`payment_intent.payment_failed` SHALL mark the purchase `FAILED` and leave both balances untouched.

#### Scenario: The card is declined
- **WHEN** `payment_intent.payment_failed` resolves to a `PENDING` add-on purchase
- **THEN** the payment row reads `FAILED` and the wallet holds no add-on allocation for it
