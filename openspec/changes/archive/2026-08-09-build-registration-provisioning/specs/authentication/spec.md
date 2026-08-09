## MODIFIED Requirements

### Requirement: Registration creates the user and the credential in one transaction

Registration SHALL create the `User` and its `AuthCredential` in a single transaction, so that
neither can exist without the other. That same transaction SHALL create the caller's billing and
credit rows through the modules that own them, so a registered user never exists without entitlement.
It SHALL NOT contact any external service.

The auth module owns the transaction because it owns registration; `billing` and `credit` join it as
participants taking the transaction client as a parameter. Pointing the dependency the other way —
`billing` owning registration — would make the largest module depend on the one built to be deleted.

Contacting no external service is what makes registration survive a Stripe outage. The Stripe objects
are provisioned afterwards, outside this transaction, and their absence is a valid state rather than
a failure.

#### Scenario: Both rows land together

- **WHEN** registration succeeds for a new email address
- **THEN** a `User` and its `AuthCredential` both exist
- **AND** the user's role is `USER`

#### Scenario: Entitlement lands in the same transaction

- **WHEN** registration succeeds for a new email address
- **THEN** that user's `BillingCustomer`, `Subscription` and `CreditWallet` exist as well

#### Scenario: A failure part-way leaves nothing behind

- **WHEN** the transaction fails after the user row has been written
- **THEN** no `User` row remains for that email address
- **AND** no billing or credit row remains for it either

#### Scenario: An already-registered email is refused

- **WHEN** registration is attempted with an email that already exists
- **THEN** the response is `400` with code `VALIDATION_FAILED`
- **AND** no second user is created

  Uniqueness is enforced by the `@unique` constraint on `User.email`, so this is asserted by
  attempting the duplicate rather than by trusting a pre-check.

#### Scenario: Registration reaches no external service

- **WHEN** registration runs with every Stripe operation configured to fail
- **THEN** registration still succeeds
