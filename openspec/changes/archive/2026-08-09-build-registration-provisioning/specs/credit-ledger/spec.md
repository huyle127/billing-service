## ADDED Requirements

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
