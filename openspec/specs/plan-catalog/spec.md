# plan-catalog Specification

## Purpose
TBD - created by archiving change build-plan-catalog-admin. Update Purpose after archive.
## Requirements
### Requirement: The catalog is enumerated from local rows
`GET /v1/plans` and `GET /v1/addon-packages` SHALL answer from active local rows, never by listing
Stripe Products.

#### Scenario: Products living in the Stripe account are invisible
- **WHEN** the public catalog is read against an account holding unrelated active Products
- **THEN** the response carries the active local rows and none of the Stripe Products

### Requirement: Creation writes Stripe first and the database second
An admin create SHALL obtain the Stripe Product and Price before writing the local row, under an
idempotency key derived from the plan code and its interval.

#### Scenario: A failed database write leaves a Stripe Price the orphan report finds
- **WHEN** a create succeeds in Stripe and its database write fails
- **THEN** no local row exists and the orphan report names the Stripe Price

#### Scenario: A double-submitted create yields one Product and one Price
- **WHEN** the same create request is submitted twice
- **THEN** Stripe holds one Product and one Price for that code and interval

### Requirement: A price change mints a new Price and archives the old one
`PATCH /v1/admin/plans/:id` SHALL create a new Price, archive the previous one, repoint the local
row, and return without migrating anybody.

#### Scenario: The plan is repointed and the old Price is archived
- **WHEN** an admin changes a plan's amount
- **THEN** the plan carries a new `stripePriceId`, the old Price is archived, and existing
  subscriptions still record the old Price

### Requirement: Subscribers are migrated from state, with no proration
The reconciler SHALL select `ACTIVE` subscriptions whose `stripePriceId` differs from their plan's,
update them at `prorationBehavior: 'none'`, and record the new Price on the row.

#### Scenario: A mispriced active subscription is moved to its plan's price
- **WHEN** the reconciler runs after a price change
- **THEN** the subscription is updated to the new Price with no proration and the row records it

#### Scenario: A second run finds nothing
- **WHEN** the reconciler runs again immediately
- **THEN** it updates no subscription and reaches Stripe for none

### Requirement: A price change never grants credits
No credit SHALL be granted by a price change or by the migration that follows it.

#### Scenario: The ledger is untouched across a reprice and its migration
- **WHEN** a plan is repriced and the reconciler migrates its subscriber
- **THEN** the balances are unchanged and no `CreditTransaction` row was written

### Requirement: Plans and packages are archived, never deleted
`DELETE /v1/admin/plans/:id` SHALL set `active = false` and archive the Stripe Price, and SHALL
refuse while an `ACTIVE` subscription points at the plan.

#### Scenario: A plan with a live subscriber cannot be archived
- **WHEN** an admin archives a plan an `ACTIVE` subscription points at
- **THEN** the request is refused with `409` `PLAN_IN_USE` and the row stays active

#### Scenario: An unused plan is archived in both systems
- **WHEN** an admin archives a plan no subscription points at
- **THEN** the row reads `active = false`, its Price is archived, and the public catalog drops it

