## MODIFIED Requirements

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
