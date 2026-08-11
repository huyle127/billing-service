## Why

The catalog is seeded and never managed: no route reads it and a price change has nowhere to
happen. **029** (`docs/wayfinder/tickets/029-build-plan-catalog-admin.md`).

## What Changes

- **Public `GET /v1/plans` and `GET /v1/addon-packages`, admin CRUD behind `@Roles(Role.ADMIN)`**,
  enumerated from local rows so the nine polluting test-account products stay invisible.
- **Create writes Stripe first, the database second**, under an idempotency key that now carries the
  interval. `stripeProductId` is stored so the cycles of one `code` share a Product.
- **A price change mints a new Price, archives the old, repoints the `Plan`, and returns
  immediately.** Prices are immutable in Stripe; changing credits alone reaches no network.
- **Migration is derived from state, not stored** — `ACTIVE` rows whose `stripePriceId` differs from
  their plan's, over `@@index([status, planId, stripePriceId])`, driven by an in-process schedule at
  `prorationBehavior: 'none'` so Stripe raises no invoice and **no credit is ever granted by a price
  change**. The run writes the new `stripePriceId`, so a second run finds nothing, and it reports
  **orphan Prices** by searching our `code` metadata — scoped, not the listing the adapter forbids.
- **Archive, never delete** in both systems, refused with `409 PLAN_IN_USE` while an `ACTIVE`
  subscription points at the plan.
- **`GET /v1/admin/users/:userId/billing`** answers from local rows; history is ticket 033.

## Capabilities

### New Capabilities

- `plan-catalog`: how the catalog is read, created, archived, repriced, and its subscribers migrated.
- `admin-billing-view`: an admin reading one user's billing state.

### Modified Capabilities

- `stripe-adapter`: the price idempotency key gains the interval, and a scoped Price search is added.

## Impact

**Clauses off `todo`**, verbatim — §4: `Plan creation writes to Stripe then the database`,
`Creation calls carry a Stripe idempotency key`, `Catalog is enumerated locally, never by listing
Stripe products`, `A price change creates a new Stripe price and archives the old`, `Existing
subscribers migrate at next renewal, no proration`, `The migration reconciler is idempotent and
resumable`, `A price change never triggers credit allocation`. **10 new tests**, at the ceiling.
**Schema:** nullable `stripeProductId` on `Plan`, `AddonPackage`. **Specs run 90 lines, over the 80
ceiling:** 029 absorbed the old 030, so seven clauses across three capabilities land at once.
