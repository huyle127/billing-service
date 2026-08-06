## ADDED Requirements

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
