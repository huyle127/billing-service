## ADDED Requirements

### Requirement: Add-on credits are granted by the payment intent, and only when it succeeds
`payment_intent.succeeded` SHALL grant the package's credits to the `ADDON` ledger and settle the
purchase's payment row to `SUCCEEDED` in one transaction, keyed on the purchase id.

#### Scenario: Success grants and records together
- **WHEN** `payment_intent.succeeded` resolves to a `PENDING` add-on purchase
- **THEN** the add-on balance rises by the package's credits and the payment row reads `SUCCEEDED`,
  both written by that one event

#### Scenario: Two purchases of one package
- **WHEN** a user buys the same package twice and both intents succeed
- **THEN** both grants land, because the key is the purchase and not the package

### Requirement: A redelivered intent grants once
A purchase that has left `PENDING` SHALL complete without work, and a concurrent second grant SHALL
be refused by the `CreditTransaction` key rather than by the handler.

#### Scenario: Redelivery
- **WHEN** `payment_intent.succeeded` is delivered again for a purchase already settled
- **THEN** the balance does not move, exactly one `ALLOCATION` row exists for that purchase, and the
  event completes

### Requirement: A failed intent grants nothing
`payment_intent.payment_failed` SHALL mark the purchase `FAILED` and leave both balances untouched.

#### Scenario: The card is declined
- **WHEN** `payment_intent.payment_failed` resolves to a `PENDING` add-on purchase
- **THEN** the payment row reads `FAILED` and the wallet holds no add-on allocation for it
