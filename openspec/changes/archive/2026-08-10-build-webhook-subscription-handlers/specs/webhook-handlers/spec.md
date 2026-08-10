## ADDED Requirements

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
