## ADDED Requirements

### Requirement: A PENDING subscription supersedes the current one
Activating a `PENDING` subscription SHALL end the user's current one in the same transaction, reset
the subscription ledger before the new allocation, and create no replacement Free subscription. The
table SHALL also carry `CANCELED → ACTIVE` on a `resume` event.

#### Scenario: Free gives way to a paid plan
- **WHEN** a `PENDING` paid subscription activates for a user still holding Free credits
- **THEN** Free is `EXPIRED`, the ledger is reset to zero, the paid plan's allocation is granted, and
  the partial unique index leaves exactly one current subscription
