## ADDED Requirements

### Requirement: Entitlement is granted in one transaction that contacts no external service

Registration SHALL create, in a single transaction, the `BillingCustomer` with a null
`stripeCustomerId`, the Free `Subscription` with a null `stripeSubscriptionId` and status `ACTIVE`,
the `CreditWallet`, and an `ALLOCATION` of the Free plan's monthly credits under the current month's
allocation key. It SHALL NOT call Stripe inside that transaction.

Our database is authoritative for entitlement and Stripe for money. A user who registers while Stripe
is unreachable gets Free access and credits immediately; only the ability to pay is deferred.

#### Scenario: A new user holds a plan and a balance the moment registration returns

- **WHEN** registration succeeds for a new email address
- **THEN** a `BillingCustomer`, an `ACTIVE` Free `Subscription`, and a `CreditWallet` exist for that
  user
- **AND** the wallet holds the Free plan's `monthlyCredits` on the subscription ledger and zero on
  the add-on ledger
- **AND** a `CreditTransaction` of type `ALLOCATION` records the grant

#### Scenario: Registration succeeds while Stripe is unreachable

- **WHEN** every Stripe operation fails and a new user registers
- **THEN** registration returns successfully
- **AND** the same rows exist with `stripeCustomerId` and `stripeSubscriptionId` both null

#### Scenario: A failure part-way leaves nothing behind

- **WHEN** the registration transaction fails after the user row has been written
- **THEN** no `User`, `BillingCustomer`, `Subscription`, `CreditWallet` or `CreditTransaction` row
  remains for that email address

#### Scenario: The billing customer exists before Stripe does

- **WHEN** registration completes and provisioning has not yet run
- **THEN** a `BillingCustomer` row exists carrying a null `stripeCustomerId`

  The row is created eagerly rather than on Stripe's answer. A row that appeared only on success
  would leave a failed provisioning with nothing to find, and locating affected users would require
  scanning `User`.

### Requirement: A subscription with no Stripe identifier is a valid state

A current `Subscription` whose `stripeSubscriptionId` is null SHALL be treated as entitlement granted
with the Stripe object pending, not as an error. The user SHALL retain full Free-tier access
throughout, and the row SHALL remain eligible for the reconciler until it is attached.

#### Scenario: A pending subscription still spends credits

- **WHEN** a user whose subscription carries no `stripeSubscriptionId` consumes credits
- **THEN** the consumption succeeds against the balance the registration grant created

#### Scenario: A pending subscription is the user's current subscription

- **WHEN** a user's only subscription carries no `stripeSubscriptionId` and status `ACTIVE`
- **THEN** it is the user's one current subscription

  The `Subscription_one_current_per_user` partial unique index counts it, so a second `ACTIVE` row
  for that user is rejected by the database.

### Requirement: The registration grant and the first zero-amount invoice describe one month

The allocation key covering the registration grant SHALL identify the subscription and the calendar
month, so that a later grant for the same subscription and month writes nothing. No application-level
guard SHALL be added for this case.

Free is a real Stripe subscription at a zero-amount price, so Stripe emits `invoice.paid` with
`billing_reason=subscription_create` for the first invoice. Both paths would otherwise grant the same
month. The key already discards the second, and a second mechanism would be a second thing to keep
correct.

#### Scenario: A second allocation for the registration month grants nothing

- **WHEN** an allocation is made for a user's subscription under the same month's key that
  registration used
- **THEN** the balance is unchanged and no second `ALLOCATION` row is written

#### Scenario: The following month's key is a different key

- **WHEN** an allocation is made for the same subscription under the next month's key
- **THEN** it grants

### Requirement: Provisioning is one idempotent routine reached from several triggers

The service SHALL expose a single provisioning routine that ensures a user's Stripe Customer and
Stripe Subscription exist and are recorded locally. It SHALL be safe to invoke repeatedly and
concurrently, and SHALL be invoked at the end of registration without blocking the response, by the
periodic reconciler, and by any later operation requiring a Stripe Customer.

#### Scenario: Provisioning attaches both identifiers

- **WHEN** provisioning runs for a user whose rows carry no Stripe identifiers
- **THEN** the `BillingCustomer` carries a `stripeCustomerId` and the `Subscription` carries a
  `stripeSubscriptionId`, a `stripePriceId` and the raw `stripeStatus`
- **AND** `syncAttempts` is zero and `syncError` is null on both rows

#### Scenario: Running it twice creates nothing twice

- **WHEN** provisioning runs a second time for a user already fully provisioned
- **THEN** the recorded identifiers are unchanged
- **AND** no further Stripe Customer or Stripe Subscription is created

#### Scenario: Two provisioners racing one user cannot both persist a customer

- **WHEN** two provisioning runs for the same user execute concurrently
- **THEN** exactly one `stripeCustomerId` is recorded and exactly one Stripe Customer exists

  `stripeCustomerId` is unique where present, so the database rejects the second write; the loser
  retries and finds the work done.

#### Scenario: Registration does not wait for Stripe

- **WHEN** registration is called
- **THEN** the response is returned without awaiting the provisioning attempt

### Requirement: Provisioning creates in Stripe first, then persists locally

Provisioning SHALL create the Stripe object before writing the identifier to the database, because
network calls are barred from transactions. Every create SHALL carry a Stripe idempotency key derived
inside the adapter and SHALL stamp our identifiers into Stripe metadata. Before creating, provisioning
SHALL search Stripe by that metadata and adopt an existing object rather than creating a second.

Stripe's idempotency keys expire after 24 hours, so a retry after a long outage falls outside the
window and the key no longer protects us. The metadata search is what covers that hole, and it is also
what makes an orphaned object traceable back to a user.

#### Scenario: A crash between Stripe and the database does not orphan a second object

- **WHEN** a Stripe Customer was created but the local write did not happen, and provisioning runs
  again after Stripe's idempotency keys have expired
- **THEN** the existing Stripe Customer is adopted and recorded
- **AND** the total number of Stripe Customers is one

#### Scenario: The same holds for the subscription

- **WHEN** a Stripe Subscription was created but the local write did not happen, and provisioning runs
  again after Stripe's idempotency keys have expired
- **THEN** the existing Stripe Subscription is adopted and recorded
- **AND** the total number of Stripe Subscriptions is one

  There is deliberately no unique constraint on `Subscription.stripeSubscriptionId`: expired rows are
  retained as history and one Stripe subscription id can legitimately appear on more than one row
  across a plan change. What protects this path is the idempotency key plus the fact that both writers
  write the same value.

### Requirement: A failed attempt is recorded on the row and retried with backoff

When provisioning fails, the service SHALL increment `syncAttempts`, record the failure in
`syncError`, and push `syncNextAttemptAt` forward by an interval that grows with the attempt count. It
SHALL NOT fail the caller that triggered it from registration.

There is no job table and no outbox. The work is fully derivable from domain state — a subscription
with no Stripe id is the record that it needs one — so the thing that needs doing is the thing that
records it, and the work cannot be lost.

#### Scenario: A failure leaves the retry state on the row

- **WHEN** the Stripe call fails during provisioning
- **THEN** `syncAttempts` has increased, `syncError` names the failure, and `syncNextAttemptAt` is
  later than it was
- **AND** the identifier is still null

#### Scenario: Backoff grows with attempts

- **WHEN** provisioning fails twice for the same row
- **THEN** the second failure pushes `syncNextAttemptAt` further out than the first did

#### Scenario: A failure during registration does not fail registration

- **WHEN** provisioning fails for a user who has just registered
- **THEN** registration has already returned successfully and the user's entitlement rows are intact

#### Scenario: A later success clears the retry state

- **WHEN** provisioning succeeds for a row that previously failed
- **THEN** `syncAttempts` is zero and `syncError` is null

### Requirement: The reconciler finds the backlog without scanning the table

The reconciler SHALL select subscriptions where `stripeSubscriptionId` is null, status is one of
`PENDING`, `ACTIVE`, `CANCELED`, `PAST_DUE`, and `syncNextAttemptAt` has passed, ordered by
`syncNextAttemptAt`, limited to a configured batch size, with `FOR UPDATE SKIP LOCKED`. The predicate
SHALL match the `Subscription_pending_sync` partial index so its cost is proportional to the
outstanding backlog rather than to table size.

#### Scenario: The sweep provisions everything outstanding

- **WHEN** several users hold subscriptions with no Stripe identifier and a sweep runs
- **THEN** each of them is provisioned and carries its identifiers

#### Scenario: A row not yet due is left alone

- **WHEN** a pending subscription's `syncNextAttemptAt` is in the future and a sweep runs
- **THEN** that row is untouched and its `syncAttempts` is unchanged

#### Scenario: Rows outside the index are never picked up

- **WHEN** a sweep runs and an `EXPIRED` subscription carries no `stripeSubscriptionId`
- **THEN** that row is not provisioned

  `EXPIRED` is excluded from the partial index because history is not a backlog.

#### Scenario: Concurrent sweeps do not process the same row

- **WHEN** two sweeps run concurrently against the same backlog
- **THEN** each pending subscription is provisioned once and exactly one Stripe Subscription exists
  per row

  `FOR UPDATE SKIP LOCKED` is what makes this hold, the same mechanism the webhook queue uses.

#### Scenario: The batch size bounds one sweep

- **WHEN** the backlog is larger than the configured batch size
- **THEN** one sweep provisions at most that many rows and the remainder stay pending for the next

### Requirement: A row pending too long is escalated by age, not by attempt count

On every sweep the service SHALL log at error level each pending row older than the configured
staleness threshold, naming the subscription and its recorded `syncError`. It SHALL NOT stop retrying
that row.

A row pending for longer than the threshold means either Stripe has been down that long or our
request is malformed and will never succeed. Attempt count says nothing about either, because backoff
makes attempts and elapsed time diverge. Retrying forever in silence is the failure mode being
avoided.

#### Scenario: An old pending row is reported

- **WHEN** a sweep runs and a pending subscription was created longer ago than the threshold
- **THEN** an error-level log names that subscription
- **AND** the row is still attempted

#### Scenario: A young pending row that has failed many times is not reported

- **WHEN** a sweep runs and a pending subscription created within the threshold has already failed
  several times
- **THEN** no escalation is logged for it

### Requirement: The sweep is driven by an in-process schedule

The service SHALL run the sweep on a configured interval, and SHALL disable it when that interval is
zero. The scheduled path SHALL invoke the same routine every other trigger invokes.

The interval is configurable, and zero-means-disabled, because the test suite and any process that
must not sweep need a way to say so without a second code path.

#### Scenario: The scheduler invokes the same routine

- **WHEN** the scheduled sweep fires
- **THEN** it performs the same work a directly invoked sweep performs

#### Scenario: A zero interval disables the schedule

- **WHEN** the configured interval is zero
- **THEN** no sweep is scheduled and pending rows are provisioned only by the other triggers
