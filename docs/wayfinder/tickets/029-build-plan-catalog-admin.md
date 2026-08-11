# 029 Build the plan and add-on catalog, price changes, and subscriber migration

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-11) -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 019, 020 -->

## Question

The catalog, and what happens to existing subscribers when an admin changes a plan's price.

**Merged from the old ticket 030 on 2026-08-10.** The split put reading and creating the catalog here
and changing it there, but the two rest on one fact: **Stripe Prices are immutable.** That is why this
ticket archives rather than deletes, and it is equally why a price change has to mint a new Price and
migrate subscribers. Split, the same idea had to be stated in both tickets and built against the same
admin controller twice.

## The catalog

- `GET /v1/plans` and `GET /v1/addon-packages` public; `/v1/admin/plans` and
  `/v1/admin/addon-packages` behind the admin guard. `GET /v1/admin/users/:userId/billing` lands here
  too, apart from its history portion, which is ticket 033. The credit adjustment route is ticket 022.
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

## The price change and the migration reconciler

- `PATCH /v1/admin/plans/:id`. **Prices are immutable in Stripe**, so a price change creates a new
  Price, archives the previous one, and repoints the local `Plan`.
- The call **returns immediately.** Migration is not a stored job — it is **derived from state**:

  ```
  subscriptions WHERE status = 'ACTIVE'
    AND stripePriceId <> (its plan's current stripePriceId)
  ```

  The `@@index([status, planId, stripePriceId])` exists for exactly this query. Each Subscription
  records the Price it is actually on, so the outstanding work is visible in the rows themselves and
  cannot be lost the way a job row can.
- **Idempotent, resumable, and self-healing** if a Stripe call fails partway through a batch. Run it
  any number of times; assert that running it twice changes nothing the second time.
- **Migration takes effect at next renewal, with no proration and no mid-period charge.**
- **A price change must never trigger credit allocation.** This is the clause that protects the ledger
  and it follows from the no-proration choice: with no proration Stripe generates no immediate
  invoice, so no `invoice.paid` with `billing_reason=subscription_update` is emitted, so ticket 026's
  invoice handler never fires. Ticket 008 noted that choosing proration here would have turned every
  price change into a mass credit giveaway. Assert the absence explicitly — the failure mode is silent.
- **Changing a plan's credit entitlement** takes effect from the next allocation. Credits already
  granted are never retroactively adjusted.
- Add-on packages follow the same rules minus subscriber migration: purchases are one-time, so a price
  change affects only future purchases.

## Requirement clauses closed

Section 4:

- Plan creation writes to Stripe then the database
- Creation calls carry a Stripe idempotency key
- Catalog is enumerated locally, never by listing Stripe products
- A price change creates a new Stripe price and archives the old
- Existing subscribers migrate at next renewal, no proration
- The migration reconciler is idempotent and resumable
- A price change never triggers credit allocation
