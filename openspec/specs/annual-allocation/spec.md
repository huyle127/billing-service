# annual-allocation

## Purpose

Annual subscriptions pay once upfront and earn credits monthly, so the months between invoices have
no payment event to hang on. This capability owns which subscriptions are due, how many months they
earn, and where they stop — driven from a schedule and from an internal endpoint, both reaching one
idempotent routine. It mints no allocation key and performs no month arithmetic of its own: the key
scheme belongs to the webhook handlers that grant the paying month, and the arithmetic to
`credit-schedule.ts`, so an annual term cannot end up with two mechanisms granting it credits.

## Requirements

### Requirement: Annual subscriptions earn their monthly credits from a scheduled routine

The service SHALL grant an annual subscription its plan's monthly credits once per elapsed month, to
subscriptions that are `ACTIVE`, or `CANCELED` while still inside `paidThroughAt`.

#### Scenario: A due annual subscription is granted the month it has reached

- **WHEN** the routine runs against an annual subscription whose `nextCreditAt` has passed
- **THEN** the wallet gains the plan's monthly credits, a `CreditTransaction` records the grant, and
  `nextCreditAt` advances one month

#### Scenario: A cancelled term still inside its paid period keeps earning

- **WHEN** the routine runs against a `CANCELED` annual subscription whose `paidThroughAt` is still
  in the future, and against a `PENDING` one
- **THEN** the cancelled subscription is granted its due month and the pending one is passed over

### Requirement: Missed months are caught up one at a time

The routine SHALL grant each missed month as its own transaction under its own month key, never as
one combined amount.

#### Scenario: Three missed months become three grants

- **WHEN** the routine runs against an annual subscription three months behind
- **THEN** three `CreditTransaction` rows exist under three distinct month keys and `nextCreditAt`
  has advanced three months

### Requirement: The routine never grants past the paid-through boundary

The routine SHALL stop at `paidThroughAt`, a boundary the service owns, so no grant depends on
Stripe being reachable.

#### Scenario: A month-end term stops on its boundary rather than inside it

- **WHEN** the routine runs against an annual term anchored on the last day of a month, with the
  clock past its boundary
- **THEN** it grants every month from the one the paying invoice left up to the last inside the term,
  each key distinct, and no key for the month the boundary falls in

### Requirement: Both triggers invoke one routine, and a repeat grants nothing

The in-process schedule and `POST /v1/internal/allocations/run` SHALL invoke the same routine, and a
second invocation over the same due months SHALL grant no credits.

#### Scenario: A second run over the same months is a no-op

- **WHEN** the routine is invoked twice without the clock advancing
- **THEN** the second invocation grants no credits, writes no `CreditTransaction`, and reports zero
