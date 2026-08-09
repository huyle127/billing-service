# credit-ledger

## Purpose

What every operation does to the two ledgers. Credits leaving: atomicity and draw order, behaviour
under concurrency, what a repeated idempotency key returns, how a reversal is bounded to one, and how
a decline is reported and counted — this is the endpoint other applications call, and the one place in
this service where money and concurrency meet. Credits arriving: what a grant does to a balance, when
a renewal replaces it rather than adding to it, and what an admin adjustment may and may not reach.
And the gate: a freeze stops consumption from both ledgers without moving either balance.

The module is a leaf — the amount, the key, and the intent behind a grant all arrive from the caller,
and the ledger knows nothing about subscriptions or billing periods.
## Requirements
### Requirement: A consumption deducts the whole amount or nothing

`POST /v1/credits/consume` SHALL deduct the full requested amount from the caller's wallet in one
transaction, or leave both ledgers untouched. It SHALL NOT deduct part of an amount it cannot fully
satisfy.

The wallet row is locked with `SELECT … FOR UPDATE` before the balances are read, so the decision and
the write cannot be separated by another caller's commit.

#### Scenario: A satisfiable amount is deducted in full

- **WHEN** a wallet holding 100 subscription credits is consumed for 30
- **THEN** the response is `200` with `success: true` and `consumed` of 30 from the subscription ledger
- **AND** the wallet holds 70 subscription credits
- **AND** one `CreditTransaction` of type `CONSUMPTION` exists, carrying `balanceAfter` of 70
- **AND** `transactions` lists that one row with its id, ledger, and amount

#### Scenario: An amount larger than both ledgers together deducts nothing

- **WHEN** a wallet holding 10 subscription and 5 add-on credits is consumed for 20
- **THEN** the response is `200` with `success: false`
- **AND** both balances are unchanged at 10 and 5
- **AND** no `CreditTransaction` row is written
- **AND** the response carries no `transactions` field at all, rather than an empty one

#### Scenario: A negative balance is refused by the database

- **WHEN** a decrement larger than a ledger's balance is written directly to the wallet row
- **THEN** the write is rejected and the balance is unchanged

  Enforced by the `CHECK` constraints `CreditWallet_subscriptionCredits_non_negative` and
  `CreditWallet_addonCredits_non_negative`, so this is asserted by attempting the violation rather
  than by trusting the service.

### Requirement: Subscription credits are drawn before add-on credits

A consumption SHALL exhaust the subscription ledger before drawing from the add-on ledger, and SHALL
write one `CreditTransaction` per ledger it draws from, all sharing the caller's idempotency key.

#### Scenario: A consumption spanning both ledgers splits in draw order

- **WHEN** a wallet holding 100 subscription and 50 add-on credits is consumed for 120
- **THEN** `consumed` reports 100 from the subscription ledger and 20 from the add-on ledger
- **AND** two `CreditTransaction` rows exist, one per ledger, sharing the one idempotency key
- **AND** `transactions` lists both rows, each with its ledger and its own amount
- **AND** the wallet holds 0 subscription and 30 add-on credits

#### Scenario: Add-on credits are untouched while subscription credits remain

- **WHEN** a wallet holding 100 subscription and 50 add-on credits is consumed for 40
- **THEN** only the subscription ledger is drawn from
- **AND** exactly one `CreditTransaction` row is written, for the subscription ledger

#### Scenario: A wallet with only add-on credits draws from the add-on ledger

- **WHEN** a wallet holding 0 subscription and 50 add-on credits is consumed for 20
- **THEN** `consumed` reports 0 from the subscription ledger and 20 from the add-on ledger
- **AND** no zero-amount transaction row is written for the subscription ledger

#### Scenario: Two ledgers can share one idempotency key

- **WHEN** two `CreditTransaction` rows carrying the same key but different ledgers are written
- **THEN** both are accepted
- **AND** a second row for the same key and the same ledger is rejected

  Enforced by `@@unique([idempotencyKey, ledger])`, asserted by attempting both writes.

### Requirement: A consumption records the caller's reason on every row it writes

Where the caller supplies a reason, it SHALL be stored on each `CreditTransaction` the consumption
writes. Where it does not, the field SHALL stay empty rather than carry a synthesised value.

Both legs of a two-ledger consumption describe one operation, so a history that showed the reason on
only one of them would be misleading about the other.

#### Scenario: Both legs of one consumption carry the same reason

- **WHEN** a consumption spanning both ledgers is requested with a reason
- **THEN** both rows carry that reason

#### Scenario: A consumption with no reason stores none

- **WHEN** a consumption is requested with no reason
- **THEN** the rows carry no reason

### Requirement: Concurrent consumption cannot oversell

Concurrent consumptions against one wallet SHALL NOT deduct more than the wallet holds. Callers that
cannot be satisfied SHALL be declined, not errored.

#### Scenario: N callers against a wallet that cannot satisfy them all

- **WHEN** 30 callers each consume 10 credits, in parallel over separate connections, from a wallet
  holding 100 subscription and 50 add-on credits
- **THEN** exactly 15 responses report `success: true` and 15 report `success: false`
- **AND** both balances end at 0
- **AND** the number of `CONSUMPTION` transactions matches the number of successes
- **AND** no request fails with a server error

  Asserted on outcome, never on timing.

### Requirement: A repeated idempotency key charges once and replays the first result

The idempotency key SHALL be required on every consumption. A second consumption carrying a key
already used for the same amount SHALL deduct nothing further and SHALL return `200` listing the rows
the first call wrote.

Credits are deducted before the caller performs its work, so a retry after a timeout must be
indistinguishable from the success it replays.

#### Scenario: A retry with the same key and amount deducts nothing further

- **WHEN** a consumption of 30 succeeds and the identical request is sent again
- **THEN** the second response is `200` with `success: true` and the same `transactions`
- **AND** the wallet balance is the same after the second call as after the first
- **AND** no additional `CreditTransaction` row exists

#### Scenario: Concurrent retries of one key charge once

- **WHEN** two identical consumptions carrying one key are sent in parallel over separate connections
- **THEN** both return `200` listing the same transaction ids
- **AND** the amount is deducted once

  The guarantee is the composite unique constraint, not application logic; a constraint violation is
  translated into the replay and never surfaces as a `5xx`.

#### Scenario: A replay outranks a freeze applied after the original call

- **WHEN** a consumption succeeds, the wallet is then frozen, and the caller retries with the same key
  and amount
- **THEN** the response is the replay of the original success, not `BILLING_FROZEN`
- **AND** a *new* consumption on that wallet is still declined with `BILLING_FROZEN`

  The retrying caller has already been charged. Answering `BILLING_FROZEN` would tell it the credits
  are still there, and it would abandon or re-charge work it has already paid for.

#### Scenario: A replay reports the balance recorded for each ledger it drew from

- **WHEN** a consumption that drew from both ledgers is replayed
- **THEN** both reported balances are the ones recorded on the original transactions

  A ledger the original consumption did not draw from has no recorded balance, and is reported as it
  currently stands.

#### Scenario: A consumption without an idempotency key is refused

- **WHEN** a consumption is requested with no idempotency key
- **THEN** the response is `400` with code `VALIDATION_FAILED`
- **AND** no credits are deducted

### Requirement: The same key with a different amount is a client fault

A consumption carrying a key already used for a different amount SHALL be refused with `400` and code
`IDEMPOTENCY_KEY_REUSED`, and SHALL deduct nothing.

One key now identifies two different operations, which is a caller bug. Returning the first result
silently would undercharge with nothing to indicate it.

#### Scenario: A reused key with a different amount is refused loudly

- **WHEN** a consumption of 30 succeeds and a consumption of 40 is sent with the same key
- **THEN** the response is `400` with code `IDEMPOTENCY_KEY_REUSED` in the standard error envelope
- **AND** the balance is unchanged from after the first call

#### Scenario: The comparison is against the total across ledgers

- **WHEN** a consumption of 120 drew 100 and 20 from the two ledgers, and 120 is sent again with the
  same key
- **THEN** the response is the replay, not `IDEMPOTENCY_KEY_REUSED`

### Requirement: Declines are outcomes, reported distinctly

A consumption that cannot proceed SHALL return `200` with `success: false` and a reason.
`INSUFFICIENT_CREDITS` and `BILLING_FROZEN` SHALL be reported as distinct reasons, and a frozen wallet
SHALL be refused whatever its balance.

#### Scenario: Insufficient credits reports the shortfall

- **WHEN** a wallet holding 3 subscription and 0 add-on credits is consumed for 10
- **THEN** the response is `200` with reason `INSUFFICIENT_CREDITS`
- **AND** it reports both current balances and the amount required

#### Scenario: A frozen wallet refuses a consumption it could afford

- **WHEN** a wallet with status `FROZEN` holding 40 credits is consumed for 10
- **THEN** the response is `200` with reason `BILLING_FROZEN`
- **AND** the balances are unchanged

#### Scenario: A frozen wallet reports freezing, not shortfall

- **WHEN** a wallet with status `FROZEN` holding 3 credits is consumed for 10
- **THEN** the reason is `BILLING_FROZEN`

### Requirement: Every decline is counted

The service SHALL increment a counter for every declined consumption, labelled by reason, through the
metrics interface in `common/metrics`.

A decline carries a `200`, so no gateway, log aggregator, or dashboard can infer one from the status
code; without the counter a user refused a thousand times is indistinguishable from a thousand
successes.

#### Scenario: A decline increments the counter for its reason

- **WHEN** one consumption is declined for insufficient credits and one for a frozen wallet
- **THEN** the decline counter records one for each reason separately

#### Scenario: A successful consumption does not increment it

- **WHEN** a consumption succeeds
- **THEN** the decline counter is unchanged

#### Scenario: A rolled-back transaction counts nothing

- **WHEN** a consumption is declined
- **THEN** the counter is incremented outside the database transaction

  A counter incremented inside a transaction that later rolls back would report a decline that never
  happened.

### Requirement: A reversal restores credits to the ledger they came from

`POST /v1/credits/reverse` SHALL take the idempotency key of a consumption and return each amount to
the ledger it was drawn from, recording one `REVERSAL` transaction per restored ledger, each linked to
the consumption row it reverses. It SHALL report what it restored, the resulting balances, and the
rows it wrote, and SHALL NOT carry a `success` flag — a reversal has no business outcome to decline,
so its result is carried by the HTTP status alone.

Reversal exists because `adjustment` is admin-authorised and add-on-only, leaving no legitimate way to
return subscription credits after a failed operation.

#### Scenario: A two-ledger consumption is restored to both ledgers

- **WHEN** a consumption of 120 that drew 100 and 20 is reversed
- **THEN** the wallet holds the balances it had before the consumption
- **AND** two `REVERSAL` transactions exist, one per ledger, each linked to its consumption row
- **AND** the response reports both restored amounts, both balances, and both rows, with no `success`
  field

#### Scenario: A reversal restores to the original ledger, not the first one

- **WHEN** a consumption that drew only from the add-on ledger is reversed
- **THEN** the add-on balance is restored
- **AND** the subscription balance is unchanged

#### Scenario: A reversal carries no idempotency key and no reason

- **WHEN** a consumption is reversed
- **THEN** the `REVERSAL` rows carry no idempotency key
- **AND** they carry no reason — `reversesId` already records what they undo

  Reusing the consumption's key would collide on `@@unique([idempotencyKey, ledger])` and the
  reversal could not be written at all.

#### Scenario: A frozen wallet can still be reversed

- **WHEN** a consumption is reversed while the wallet status is `FROZEN`
- **THEN** the credits are restored

#### Scenario: An unknown key cannot be reversed

- **WHEN** a reversal names a key with no consumption behind it
- **THEN** the response is `404` with code `NOT_FOUND`

### Requirement: A consumption is reversed at most once

A consumption SHALL NOT be reversed twice. A repeated reversal request SHALL return `200` with the
first reversal's result.

#### Scenario: A second reversal writes nothing further

- **WHEN** a consumption is reversed and the identical request is sent again
- **THEN** the second response is `200` reporting the first reversal's result
- **AND** the balance is the same after the second call as after the first
- **AND** no additional `REVERSAL` row exists

#### Scenario: A second reversal row is refused by the database

- **WHEN** a second `CreditTransaction` is written with a `reversesId` already used
- **THEN** the write is rejected

  Enforced by `reversesId @unique`, asserted by attempting the violation. The service never decides
  this with a check-then-write.

### Requirement: Credit routes act on the authenticated caller's own wallet

Both credit routes SHALL require a valid access token and SHALL resolve the wallet from the identity
on the request. They SHALL NOT accept a user id in the request.

#### Scenario: An absent or invalid token is refused

- **WHEN** a consumption is requested with no token, or with one that is malformed, expired, or of the
  refresh type
- **THEN** the response is `401` with code `UNAUTHORIZED`
- **AND** no credits are deducted

#### Scenario: A body that names a user is refused outright

- **WHEN** a consumption request carries a user id in its body alongside a valid token
- **THEN** the response is `400` with code `VALIDATION_FAILED`
- **AND** neither the caller's wallet nor the named user's wallet is touched

  The global validation pipe rejects properties no DTO declares, so a body cannot name a wallet even
  to have the attempt ignored.

#### Scenario: A caller with no wallet is a missing resource

- **WHEN** a consumption is requested by an authenticated user with no wallet row
- **THEN** the response is `404` with code `NOT_FOUND`

#### Scenario: A malformed amount is a client fault

- **WHEN** a consumption is requested with an amount that is zero, negative, or not an integer
- **THEN** the response is `400` with code `VALIDATION_FAILED`

### Requirement: The credit module stays a leaf

`src/credit/` SHALL NOT import from `billing`, `user`, or `auth`. The amount and the idempotency key
arrive from the caller; the ledger does not interpret the key and knows nothing about subscriptions.

This is the rule that keeps the module graph acyclic. If credit ever looks up a subscription to decide
an amount, the cycle is back.

#### Scenario: No import crosses the boundary

- **WHEN** the source files under `src/credit/` are scanned
- **THEN** none imports from `src/billing/`, `src/user/`, or `src/auth/`

#### Scenario: The verified identity arrives without an auth import

- **WHEN** a credit route reads the caller's user id
- **THEN** it reads it from the identity a guard placed on the request, published by `common/`

### Requirement: An allocation joins the caller's transaction

`allocate` SHALL accept the caller's transaction client as its first parameter and SHALL NOT open a
transaction of its own. The grant and the caller's own writes SHALL commit together or not at all.

Allocation is never a flow of its own: it lands beside subscription activation, a payment record, and
a `SubscriptionEvent`. The service owning the flow opens the transaction and participants accept it.

#### Scenario: A grant rolls back with the caller's transaction

- **WHEN** a caller allocates credits and then fails before its transaction commits
- **THEN** the balance is unchanged
- **AND** no `CreditTransaction` row exists for that allocation key

#### Scenario: A grant commits with the caller's transaction

- **WHEN** a caller allocates credits inside a transaction that commits
- **THEN** the balance carries the granted amount
- **AND** one `ALLOCATION` row exists carrying the resulting balance in `balanceAfter`

### Requirement: An allocation names its ledger and carries an opaque key

`allocate` SHALL take the target ledger, the amount, and an idempotency key from the caller, and SHALL
store the key on the row it writes. It SHALL NOT construct, parse, or interpret the key, and SHALL NOT
read any subscription to decide what to grant.

The key identifies a subscription and a month, but only to the billing module that builds it. The
ledger enforces that no two allocations share a key; it does not enforce what a key means. This is
what keeps `credit` a leaf.

#### Scenario: A subscription grant lands on the subscription ledger

- **WHEN** an allocation of 200 names the subscription ledger
- **THEN** the subscription balance rises by 200 and the add-on balance is unchanged
- **AND** the row is an `ALLOCATION` on the subscription ledger carrying the caller's key

#### Scenario: An add-on grant lands on the add-on ledger

- **WHEN** an allocation names the add-on ledger
- **THEN** the add-on balance rises and the subscription balance is unchanged

#### Scenario: Two keys the ledger cannot tell apart both grant

- **WHEN** two allocations for the same month arrive under two different keys
- **THEN** both grant

  The ledger enforces uniqueness, not meaning. A caller that builds two keys for one month has
  double-allocated, and that is a defect in the caller, not in the ledger.

#### Scenario: Reconciliation fields are recorded but are not the key

- **WHEN** an allocation is made with a Stripe invoice id and a period start
- **THEN** the row carries both alongside the idempotency key
- **AND** an allocation made without them still succeeds

  The invoice-less paths — the registration grant and the annual cron — are why the key is opaque
  rather than the invoice and period pair.

### Requirement: An allocation is idempotent on the caller's key

An allocation carrying a key already used on the same ledger SHALL grant nothing further and SHALL
return the row the first call wrote.

Three independent paths can reach one month's entitlement — the `invoice.paid` webhook, the annual
cron, and the registration grant — so the guarantee has to survive them overlapping and running
concurrently.

#### Scenario: A repeated key grants nothing further

- **WHEN** an allocation of 200 succeeds and the identical allocation is made again
- **THEN** the balance is the same after the second call as after the first
- **AND** no additional `ALLOCATION` row exists
- **AND** the result names the row the first call wrote

#### Scenario: Concurrent allocations under one key grant once

- **WHEN** two allocations carrying one key are made in parallel over separate connections
- **THEN** the amount is granted once
- **AND** neither caller receives a server error

  The guarantee is the wallet lock, not application logic: the second caller waits on
  `SELECT … FOR UPDATE`, then reads the first caller's committed row and replays it. The violation
  cannot be translated into the replay, because `allocate` runs inside the caller's transaction and a
  unique violation aborts it. What survives the lock is a cross-wallet key collision, where a replay
  would answer with another user's row, so it surfaces.

#### Scenario: Two months under two keys both grant

- **WHEN** one subscription is allocated for two different months under two different keys
- **THEN** both grant and the balance carries both amounts

#### Scenario: A duplicate key on one ledger is refused by the database

- **WHEN** a second `CreditTransaction` is written with an idempotency key and ledger already used
- **THEN** the write is rejected

  Enforced by `@@unique([idempotencyKey, ledger])`, asserted by attempting the violation.

### Requirement: A renewal replaces subscription credits; unused credits do not roll over

An allocation marked as replacing SHALL zero whatever remains on the subscription ledger before
granting the new period's credits, writing a `RESET` row for the forfeited remainder and an
`ALLOCATION` row for the grant, both within the one call. Unused subscription credits SHALL NOT
survive into the next billing cycle.

An allocation not marked as replacing SHALL add to the balance. That is the mid-cycle plan change,
which grants the new plan's full monthly credits on top of what the user already holds — an
intentional business rule, not an accounting error.

Both rows are written by one call so that a retry cannot zero a balance it has already granted.

#### Scenario: A renewal lands on the plan amount, not the sum

- **WHEN** a wallet holding 30 subscription credits receives a replacing allocation of 200
- **THEN** the subscription balance is 200, not 230
- **AND** a `RESET` row records −30 with `balanceAfter` of 0
- **AND** an `ALLOCATION` row records 200 with `balanceAfter` of 200

#### Scenario: A replacing allocation leaves add-on credits alone

- **WHEN** a wallet holding 30 subscription and 40 add-on credits receives a replacing allocation
- **THEN** the add-on balance is still 40

#### Scenario: A retried renewal does not zero the balance a second time

- **WHEN** a replacing allocation of 200 succeeds and the identical allocation is made again
- **THEN** the subscription balance is still 200
- **AND** no further `RESET` and no further `ALLOCATION` row exist

#### Scenario: The reset leg carries no idempotency key

- **WHEN** a replacing allocation writes both rows
- **THEN** the `ALLOCATION` row carries the caller's key
- **AND** the `RESET` row carries none

  Both rows sit on the subscription ledger, so a shared key would collide on
  `@@unique([idempotencyKey, ledger])` and the pair could not be written at all.

#### Scenario: A mid-cycle plan change adds rather than replaces

- **WHEN** a wallet holding 30 subscription credits receives a non-replacing allocation of 200
- **THEN** the subscription balance is 230
- **AND** no `RESET` row is written

#### Scenario: Add-on credits are never replaced

- **WHEN** a replacing allocation names the add-on ledger
- **THEN** it is refused and nothing is written

  Add-on credits never reset and never expire, so a replacing grant against them has no legitimate
  caller.

### Requirement: Expiry forfeits subscription credits through a RESET

`reset` SHALL accept the caller's transaction client, zero the subscription ledger, and record the
forfeited amount as a `RESET` row. It SHALL leave the add-on ledger untouched. A wallet whose
subscription ledger is already empty SHALL be left alone with no row written.

The caller is the lifecycle machine, on expiry.

#### Scenario: Expiry forfeits what remains

- **WHEN** a wallet holding 120 subscription and 50 add-on credits is reset
- **THEN** the subscription balance is 0 and the add-on balance is 50
- **AND** a `RESET` row records −120 with `balanceAfter` of 0

#### Scenario: Resetting an empty ledger writes nothing

- **WHEN** a wallet holding 0 subscription credits is reset
- **THEN** no `CreditTransaction` row is written

  A zero-amount row records nothing that happened, and consumption already establishes that a ledger
  it did not touch gets no row.

### Requirement: An admin adjustment targets the add-on ledger only

`adjust` SHALL write an `ADJUSTMENT` row against the add-on ledger and SHALL offer no way to name a
different one. The subscription ledger SHALL NOT be reachable by any adjustment, from any caller.

The restriction is a domain rule, so it lives in the service. Enforced in the controller it would hold
for the HTTP caller and for nobody else. Subscription credits are returned by reversal, which is what
that transaction type exists for.

#### Scenario: A positive adjustment credits the add-on ledger

- **WHEN** an admin adjusts a wallet by +100
- **THEN** the add-on balance rises by 100 and the subscription balance is unchanged
- **AND** an `ADJUSTMENT` row exists on the add-on ledger carrying the admin's reason

#### Scenario: A negative adjustment debits the add-on ledger

- **WHEN** an admin adjusts a wallet holding 100 add-on credits by −40
- **THEN** the add-on balance is 60 and the subscription balance is unchanged

#### Scenario: A request naming a ledger is refused

- **WHEN** an adjustment request carries a ledger in its body
- **THEN** the response is `400` with code `VALIDATION_FAILED`
- **AND** no balance changes

  The global validation pipe rejects properties no DTO declares, so the subscription ledger cannot be
  named even to have the attempt ignored.

### Requirement: An adjustment cannot drive the add-on balance below zero

An adjustment whose amount exceeds the add-on balance SHALL be refused with `400` and code
`ADJUSTMENT_EXCEEDS_BALANCE`, and SHALL write nothing.

This is a caller fault, not a business outcome: an admin asked for something the ledger cannot do, and
answering `200` would leave them believing it happened.

#### Scenario: An over-large debit is refused

- **WHEN** a wallet holding 30 add-on credits is adjusted by −50
- **THEN** the response is `400` with code `ADJUSTMENT_EXCEEDS_BALANCE` in the standard error envelope
- **AND** the balance is still 30 and no row is written

#### Scenario: A debit down to exactly zero is allowed

- **WHEN** a wallet holding 30 add-on credits is adjusted by −30
- **THEN** the add-on balance is 0 and an `ADJUSTMENT` row records −30

#### Scenario: A negative balance is refused by the database

- **WHEN** an add-on balance below zero is written directly to the wallet row
- **THEN** the write is rejected and the balance is unchanged

  Enforced by the `CHECK` constraint `CreditWallet_addonCredits_non_negative`, so this is asserted by
  attempting the violation rather than by trusting the service.

### Requirement: The adjustment route is admin-only and names its subject in the path

`POST /v1/admin/users/:userId/credits/adjust` SHALL require an `ADMIN` token and SHALL act on the user
named in the path, not on the caller.

This is the one credit route that acts on someone else's wallet, which is exactly why it is the one
that requires an admin role.

#### Scenario: A user token is refused

- **WHEN** a valid `USER` token reaches the adjustment route
- **THEN** the response is `403` with code `FORBIDDEN`
- **AND** no balance changes

#### Scenario: An absent token is refused before the role is considered

- **WHEN** no token reaches the adjustment route
- **THEN** the response is `401` with code `UNAUTHORIZED`

#### Scenario: A user with no wallet is a missing resource

- **WHEN** an admin adjusts a user who has no wallet row
- **THEN** the response is `404` with code `NOT_FOUND`

#### Scenario: A malformed amount is a client fault

- **WHEN** an adjustment is requested with an amount that is zero or not an integer
- **THEN** the response is `400` with code `VALIDATION_FAILED`

### Requirement: A freeze gates consumption on both ledgers and moves no balance

`freeze` and `unfreeze` SHALL accept the caller's transaction client and SHALL set `WalletStatus`
alone. A freeze SHALL block consumption from **both** ledgers. It SHALL NOT deduct, expire, or
otherwise alter either balance, and SHALL NOT write a `CreditTransaction` row — nothing moved.

Add-on credits were bought outright. A freeze follows a failed *subscription* payment, and taking or
expiring purchased credits because of it would be taking something already paid for.

#### Scenario: Add-on credits survive a freeze intact

- **WHEN** a wallet holding 50 add-on credits is frozen
- **THEN** the add-on balance is still 50
- **AND** no `CreditTransaction` row is written

#### Scenario: A frozen wallet refuses a draw the add-on ledger could satisfy

- **WHEN** a frozen wallet holding 0 subscription and 50 add-on credits is consumed for 10
- **THEN** the consumption is declined with `BILLING_FROZEN`

#### Scenario: Unfreezing returns the same add-on balance

- **WHEN** a wallet holding 50 add-on credits is frozen and later unfrozen
- **THEN** the add-on balance is still 50 and consumption succeeds again

#### Scenario: Freezing a frozen wallet changes nothing

- **WHEN** a wallet already `FROZEN` is frozen again, or an `ACTIVE` wallet is unfrozen
- **THEN** the status and both balances are unchanged

  The callers are webhook handlers, which can be delivered the same event twice.

### Requirement: A freeze gates consumption only

Allocation, adjustment, and reset SHALL apply to a frozen wallet.

Resolving a past-due subscription unfreezes the wallet and allocates the next period in one
transaction, and forfeiting credits on expiry has no reason to require an unfrozen wallet. A freeze
that blocked writing would make both flows order-dependent for no benefit.

#### Scenario: A frozen wallet can be allocated to

- **WHEN** a frozen wallet is allocated 200 subscription credits and then unfrozen
- **THEN** the balance carries the 200 and consumption succeeds

#### Scenario: A frozen wallet can be adjusted and reset

- **WHEN** a frozen wallet is adjusted and reset
- **THEN** both take effect

### Requirement: A wallet is created by the ledger inside the caller's transaction

The credit module SHALL expose wallet creation as a primitive taking the caller's transaction client,
so that a wallet lands with the rows the caller creates alongside it or not at all. A user SHALL hold
at most one wallet, enforced by the `@unique` on `CreditWallet.userId`.

`CreditWallet` is a table the credit module owns, so no other module may write it. Creation joins the
caller's transaction for the same reason allocation does: registration must produce a user with a
wallet, or no user.

#### Scenario: A new wallet opens empty and active

- **WHEN** a wallet is created for a user
- **THEN** both ledgers hold zero and the wallet's status is `ACTIVE`

#### Scenario: The wallet rolls back with its caller

- **WHEN** a wallet is created inside a transaction that then fails
- **THEN** no `CreditWallet` row exists for that user

#### Scenario: A second wallet for one user is rejected by the database

- **WHEN** a second `CreditWallet` is created for a user who already holds one
- **THEN** the write is rejected

  `CreditWallet.userId` is `@unique`, so this is asserted by attempting the violation rather than by
  trusting a pre-check.

#### Scenario: A freshly created wallet can be allocated to in the same transaction

- **WHEN** a wallet is created and then allocated to within one transaction
- **THEN** the committed wallet holds the allocated amount and carries its `ALLOCATION` row

