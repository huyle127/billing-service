## ADDED Requirements

### Requirement: The first paid invoice activates a pending subscription

The transition table SHALL carry `PENDING + renew → ACTIVE` recording `CREATED`, so a caller
requests the same transition whether a subscription is being activated or renewed, and no caller
reads the stored status to decide which.

#### Scenario: Payment authentication completes
- **WHEN** a renew transition is applied to a `PENDING` subscription
- **THEN** the row reads `ACTIVE` and one `SubscriptionEvent` of type `CREATED` exists for it
