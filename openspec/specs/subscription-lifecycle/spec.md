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
to `PAST_DUE`, and unfreeze it in every transaction that moves it out of `PAST_DUE`, whatever
the destination. Neither SHALL allocate credits.

#### Scenario: A renewal payment fails and is then paid
- **WHEN** an active subscription goes past due and is later resolved
- **THEN** the wallet is `FROZEN` while past due and `ACTIVE` afterwards, and no `ALLOCATION`
  transaction is written by either transition

#### Scenario: Dunning gives up on a past due subscription
- **WHEN** a past due subscription expires and is replaced by a Free subscription
- **THEN** the wallet is `ACTIVE`, so the Free plan's next grant is spendable

### Requirement: Subscription credit allocation has one owner

One service SHALL own granting a subscription's plan credits for a billing month, keyed on the
subscription and that month. Every trigger SHALL route through it, and a repeated grant for the
same subscription and month SHALL allocate nothing further.

#### Scenario: Registration grants through the owner
- **WHEN** a user registers and the same subscription and month is granted a second time
- **THEN** the wallet holds the Free plan's monthly credits and exactly one `ALLOCATION`
  transaction exists for that key

### Requirement: The first paid invoice activates a pending subscription

The transition table SHALL carry `PENDING + renew → ACTIVE` recording `CREATED`, so a caller
requests the same transition whether a subscription is being activated or renewed, and no caller
reads the stored status to decide which.

#### Scenario: Payment authentication completes
- **WHEN** a renew transition is applied to a `PENDING` subscription
- **THEN** the row reads `ACTIVE` and one `SubscriptionEvent` of type `CREATED` exists for it

### Requirement: A PENDING subscription supersedes the current one

Activating a `PENDING` subscription SHALL end the user's current one in the same transaction,
resetting the subscription ledger before the new plan's allocation is granted, and SHALL create no
replacement Free subscription. The partial unique index `Subscription_one_current_per_user` is what
makes the ordering mandatory rather than merely tidy: the superseded row must leave the current set
before the activating row enters it.

#### Scenario: Free gives way to a paid plan
- **WHEN** a `PENDING` paid subscription activates for a user still holding Free credits
- **THEN** Free is `EXPIRED` recording the supersession, the subscription ledger is reset to zero,
  the paid plan's allocation is granted, and exactly one current subscription remains

### Requirement: A canceled subscription resumes

The transition table SHALL carry `CANCELED + resume → ACTIVE` recording `RESUMED`, and every
transition reaching `ACTIVE` SHALL clear `canceledAt`. A resumed subscription still carrying the
timestamp of its cancellation reads as cancelled to anything querying that column.

#### Scenario: Resumed before the period ends
- **WHEN** a `resume` transition is applied to a `CANCELED` subscription
- **THEN** the row reads `ACTIVE` with `canceledAt` cleared, and one `SubscriptionEvent` of type
  `RESUMED` exists for it
