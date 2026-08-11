## MODIFIED Requirements

### Requirement: The adapter never enumerates the Stripe catalog
No operation SHALL list Products or Prices. A Price search scoped to an exact `metadata['code']`
value is permitted: it returns only objects this service named, and cannot reach the nine unrelated
products in account `acct_1TlhMSFaNFL0w4nv` that a list call returns.

#### Scenario: No listing operation exists to be called
- **WHEN** the adapter interface is inspected for an operation that lists Products or Prices
- **THEN** none exists, and the Price search requires a plan code to match

### Requirement: Creation calls carry an idempotency key derived from our identifiers
Every create call SHALL carry an `Idempotency-Key` computed from an identifier this service holds —
`customer:{userId}`, `subscription:{subscriptionId}`, and for a catalog write the plan `code` with
its interval, since one code carries both a monthly and an annual price. The adapter SHALL compute
it; callers SHALL NOT pass one.

#### Scenario: The key is present and derived, not random
- **WHEN** a Customer is created for a user
- **THEN** the call carries the idempotency key `customer:{userId}`
- **AND** creating a Subscription carries `subscription:{subscriptionId}`

#### Scenario: A retry inside the window returns the original object
- **WHEN** the same create operation is issued twice with the same derived key
- **THEN** the second call returns the object the first created
- **AND** no second object exists

#### Scenario: Two cycles of one code do not collide
- **WHEN** a monthly and an annual Price are created for one code at the same amount
- **THEN** the calls carry different keys and Stripe holds two distinct Prices
