## ADDED Requirements

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
