# 029 Build the plan and add-on catalog with admin CRUD

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 019, 020 -->

## Question

Read and create the catalog. Price changes and subscriber migration are ticket 030 — this ticket
stops before them.

- `GET /v1/plans` and `GET /v1/addon-packages` public; `/v1/admin/plans` and
  `/v1/admin/addon-packages` behind the admin guard. `GET /v1/admin/users/:userId/billing` lands here
  too. The credit adjustment route is ticket 022.
- **Stripe owns price, we own credit entitlement.** Stripe has no concept of credits, so a local
  `Plan` row is required either way — ticket 008 dissolved the source-of-truth question rather than
  answering it.
- **Internal identity is the plan `code`** (`pro_monthly`), never the Stripe Price ID. Price IDs differ
  between test and live mode, which makes them environment-specific mappings rather than identifiers.
- **Create in Stripe first, database second** — network calls are barred from transactions. A failure
  between the two leaves an orphaned Stripe Price, so build the reconciliation check that finds Stripe
  Prices with no corresponding `Plan`.
- **Every creation call carries a Stripe idempotency key derived from the plan code**, so a retried or
  double-submitted admin request cannot produce duplicate Products or Prices.
- **Archive, never delete**, in both systems. Stripe does not permit deleting a Product that has
  Prices, so `active = false` is the only real option and the local catalog must match.
- **Enumerate the catalog from local records only, never by listing Stripe Products.** This is not
  stylistic: ticket 002 found **nine leftover products polluting the test account** — seven named
  `myproduct`, two named `Dahlia Verify Pro`, all still active. Any listing that reads Stripe picks
  them up. Assert that the endpoint does not return them.

**Add-on credit amounts — settled 2026-08-05. `100` and `500` stand.** Ticket 001 flagged them as
invented placeholders, which they were, but they turn out to be consistent with the pricing already
in the catalog rather than arbitrary. Pro is $20 for 200 monthly credits, so the reference rate is
**$0.10 per credit**. The $10 package at 100 credits matches that rate exactly; the $40 package at
500 credits is $0.08 per credit, a 20% volume discount. Keep both, and treat $0.10 as the anchor any
future package is priced against.

Seed them in `prisma/seed.ts` as the real entitlement, not as a placeholder comment.

## Requirement clauses closed

Section 4:

- Plan creation writes to Stripe then the database
- Creation calls carry a Stripe idempotency key
- Catalog is enumerated locally, never by listing Stripe products
