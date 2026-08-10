# subscription-lifecycle Specification

## Purpose
TBD - created by archiving change build-subscription-lifecycle. Update Purpose after archive.
## Requirements
### Requirement: Lifecycle state is set by this service

The service SHALL set a subscription's status from its own transition table. No transition
input, and no business rule, SHALL read the stored `stripeStatus`, which is recorded verbatim
for reconciliation only.

#### Scenario: Stripe status disagrees with ours
- **WHEN** a transition is applied to a subscription whose `stripeStatus` reads `active`
- **THEN** the resulting status is the one the transition table names, and `stripeStatus` is
  written unchanged from the input

### Requirement: Every applied transition is recorded

The service SHALL append one `SubscriptionEvent` carrying the event type, the reason, and the
originating Stripe event id inside the same transaction that writes the new status.

#### Scenario: A transition that changes status
- **WHEN** an active subscription is canceled with a reason and a Stripe event id
- **THEN** the row reads `CANCELED` and exactly one `SubscriptionEvent` of type `CANCELED`
  carrying that reason and that Stripe event id exists for it

### Requirement: A transition the table does not carry changes nothing

The service SHALL answer `unchanged` for a transition the table does not carry, writing no
status and appending no `SubscriptionEvent`.

#### Scenario: A late deletion against an already-expired subscription
- **WHEN** an expire transition is applied to a subscription already `EXPIRED`
- **THEN** the answer is `unchanged`, the row is untouched, and its `SubscriptionEvent` count is
  the same before and after

### Requirement: Cancel keeps the subscription current

The service SHALL leave a canceled subscription current, so access and credits continue until
the period ends.

#### Scenario: Cancel does not release the current slot
- **WHEN** an active subscription is canceled
- **THEN** its status is `CANCELED`, `canceledAt` is set from the injected clock, its credit
  balance is unchanged, and creating a second current subscription for the same user is rejected
  by the one-current-subscription partial unique index

### Requirement: Expiry forfeits credits and downgrades to Free

The service SHALL, in one transaction, mark the subscription `EXPIRED`, write a `RESET`
emptying the subscription credit ledger, and create a Free `Subscription` with
`stripeSubscriptionId` unset. The expiring row SHALL leave the current set before the Free row
enters it.

#### Scenario: A paid subscription expires
- **WHEN** an active paid subscription holding subscription credits expires
- **THEN** the old row reads `EXPIRED`, a `RESET` transaction takes the subscription ledger to
  zero, add-on credits are untouched, and one `ACTIVE` Free subscription exists with no Stripe
  subscription id

#### Scenario: The Free row is created before the old row is released
- **WHEN** the two writes are attempted in the reverse order
- **THEN** the one-current-subscription partial unique index rejects the transaction

### Requirement: Past due freezes the wallet, resolution unfreezes it

The service SHALL freeze the user's credit wallet in the transaction that moves a subscription
to `PAST_DUE`, and unfreeze it in the transaction that moves it back to `ACTIVE`. Resolution
SHALL NOT allocate credits.

#### Scenario: A renewal payment fails and is then paid
- **WHEN** an active subscription goes past due and is later resolved
- **THEN** the wallet is `FROZEN` while past due and `ACTIVE` afterwards, and no `ALLOCATION`
  transaction is written by either transition

### Requirement: Subscription credit allocation has one owner

One service SHALL own granting a subscription's plan credits for a billing month, keyed on the
subscription and that month. Every trigger SHALL route through it, and a repeated grant for the
same subscription and month SHALL allocate nothing further.

#### Scenario: Registration grants through the owner
- **WHEN** a user registers and the same subscription and month is granted a second time
- **THEN** the wallet holds the Free plan's monthly credits and exactly one `ALLOCATION`
  transaction exists for that key
