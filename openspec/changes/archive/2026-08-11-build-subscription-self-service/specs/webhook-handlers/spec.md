## ADDED Requirements

### Requirement: A held downgrade lands at renewal and nowhere else
A paid renewal SHALL apply and then clear `pendingPlanId` and `pendingCycle` before credits are
granted; sync SHALL NOT write `planId` from a price that is the subscription's pending plan.

#### Scenario: The renewal grants the new plan's credits
- **WHEN** a renewal invoice is paid for a subscription holding a pending downgrade
- **THEN** `planId` and `cycle` take the pending values, both clear, and credits follow the new plan

#### Scenario: The update event a downgrade emits
- **WHEN** `customer.subscription.updated` arrives carrying the downgraded price
- **THEN** `stripePriceId` and `stripeStatus` are written and `planId` is left unchanged

### Requirement: Payment method events keep the local references in step
`payment_method.attached` SHALL record the reference and `.detached` SHALL mark it detached.

#### Scenario: A redelivered attach
- **WHEN** `payment_method.attached` is processed twice for the same payment method
- **THEN** exactly one `PaymentMethod` row exists
