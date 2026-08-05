# 030 Build the price change and subscriber migration reconciler

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 029 -->

## Question

What happens to existing subscribers when an admin changes a plan's price.

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
  invoice, so no `invoice.paid` with `billing_reason=subscription_update` is emitted, so ticket 027's
  handler never fires. Ticket 008 noted that choosing proration here would have turned every price
  change into a mass credit giveaway. Assert the absence explicitly — the failure mode is silent.
- **Changing a plan's credit entitlement** takes effect from the next allocation. Credits already
  granted are never retroactively adjusted.
- Add-on packages follow the same rules minus subscriber migration: purchases are one-time, so a price
  change affects only future purchases.

## Requirement clauses closed

Section 4:

- A price change creates a new Stripe price and archives the old
- Existing subscribers migrate at next renewal, no proration
- The migration reconciler is idempotent and resumable
- A price change never triggers credit allocation
