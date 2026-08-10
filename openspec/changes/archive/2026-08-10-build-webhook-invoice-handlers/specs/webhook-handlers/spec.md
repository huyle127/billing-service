## ADDED Requirements

### Requirement: Payment is read from the invoice status

A handler SHALL treat an invoice as paid only when its `status` reads `paid`, and SHALL NOT read the
removed `paid` boolean.

#### Scenario: An invoice event arrives unpaid
- **WHEN** `invoice.paid` resolves to an invoice whose status is not `paid`
- **THEN** no `ALLOCATION` and no `PaymentTransaction` are written

### Requirement: Only three billing reasons owe credits

A handler SHALL grant credits when the invoice's `billing_reason` is `subscription_create`,
`subscription_cycle` or `subscription_update`, and nothing for any other reason.

#### Scenario: A manual invoice is paid
- **WHEN** a paid invoice carries `billing_reason` of `manual`
- **THEN** no `ALLOCATION` is written, while one carrying `subscription_cycle` for the same
  subscription grants the plan's monthly credits

### Requirement: A grant is keyed on the invoice period, not the processing time

A handler SHALL derive the allocation key from the invoice's `period_start`, so the same invoice
grants once however late or however often it is delivered.

#### Scenario: A paid invoice is redelivered in a later month
- **WHEN** the same paid invoice is processed twice, the second time after the clock has moved into
  the next month
- **THEN** exactly one `ALLOCATION` exists for that subscription and period

### Requirement: The paid-through boundary and the annual credit date are ours

A handler SHALL write `paidThroughAt` from the invoice's `period_end` on every paid invoice, and
`nextCreditAt` one month past its `period_start` for an annual subscription only.

#### Scenario: An annual subscription is paid
- **WHEN** a paid invoice for an annual subscription is processed
- **THEN** `paidThroughAt` is the invoice's period end and `nextCreditAt` is one month past its
  period start, while the same flow on a monthly subscription leaves `nextCreditAt` unset

### Requirement: One payment record per invoice, and none for a zero-amount one

A handler SHALL record a `PaymentTransaction` against the invoice, `FAILED` on a failed payment and
`SUCCEEDED` on a paid one, at most one row per invoice because `stripeInvoiceId` is unique, and
nothing at all for an invoice of zero amount.

#### Scenario: A payment fails and the retry succeeds
- **WHEN** `invoice.payment_failed` is followed by `invoice.paid` for the same invoice
- **THEN** exactly one `PaymentTransaction` exists for it, reading `SUCCEEDED`, and the unique
  `stripeInvoiceId` constraint rejects any attempt to insert a second

#### Scenario: The Free plan's monthly invoice
- **WHEN** a paid invoice of zero amount is processed
- **THEN** the plan's monthly credits are granted and no `PaymentTransaction` is written

### Requirement: A failed payment moves the subscription past due

A handler SHALL drive the past-due transition on `invoice.payment_failed` and the renew transition on
`invoice.paid`, reaching status only through the transition table. Where that transition answers
`unchanged`, no part of the invoice SHALL be applied — no grant, no boundary, no payment record.

#### Scenario: Dunning and recovery
- **WHEN** a renewal payment fails and a later payment for it succeeds
- **THEN** the subscription reads `PAST_DUE` then `ACTIVE`, the wallet is frozen then thawed, and the
  recovering payment grants its period's credits

#### Scenario: An invoice arriving after the subscription has expired
- **WHEN** a paid invoice is processed against an already-expired subscription
- **THEN** no `ALLOCATION` and no `PaymentTransaction` are written
