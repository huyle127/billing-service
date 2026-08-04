# 008 Decide plan and add-on package configuration

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- output: requirements section 4 "Plan Catalog Management", prisma.config.ts -->
<!-- blocked-by: -->

## Question

Where do plan definitions live, and what is the source of truth?

Free (50 credits/month), Pro (200 credits/month), the monthly and annual billing cycles, and the
fixed add-on credit packages all have to be defined somewhere. Requirements §9 says admins can
"manage subscription, addon plans" — which pushes toward runtime-editable data rather than code.
But Stripe also holds Products and Prices, and duplicating pricing in two systems that can
disagree is a classic source of billing bugs.

Options to weigh:

- **Stripe as source of truth**, with plans read from Stripe Products and Prices. No drift, but
  admin edits mean writing to Stripe, and local logic depends on a network call.
- **Database tables as source of truth**, holding a reference to the Stripe Price ID. Admin CRUD
  is natural; risk is drift between our credit amounts and Stripe's pricing.
- **Static configuration in code.** Simplest and version-controlled, but contradicts the admin
  plan-management requirement.

Also to settle:

- What exactly can an admin change? Price, credit amount, both? What happens to users already on
  a plan when its credit allocation changes?
- How are add-on packages modelled — same table as subscription plans, or separate?
- What identifies a plan internally, given Stripe Price IDs differ between test and live mode?

Depends on 003 for what Stripe Products and Prices actually guarantee, and on 002 for the
inventory of what already exists in the Stripe account.

## Answer

Recorded in requirements §4 under **Plan Catalog Management**.

**The framing in the question was a false binary.** "Stripe or the database as source of truth"
cannot be answered because two different things are configured: Stripe owns **price**, since it
performs the charge; the Billing Service owns **credit entitlement**, which Stripe has no concept
of. A local `Plan` table is required under every option, because there is nowhere else for
`monthlyCredits` to live. The real question was only what admins may change.

**Decision: full CRUD.** Admins create and update plans and packages in the Billing Service, which
creates the corresponding Stripe Product and Price via the API. This matches requirements §9
literally. The lighter option — admins edit credits only, prices managed in the Stripe Dashboard —
was recommended and not taken; the consequences below are therefore requirements, not caveats.

**Forced by the decision:**

- **Stripe first, database second**, because network calls are barred from transactions. A failure
  between the two orphans a Stripe Price, so a reconciliation job must detect Prices with no Plan.
- **Idempotency key on every creation call**, derived from the plan code, so a double-submitted or
  retried admin request cannot mint duplicate Products.
- **Archive, never delete.** Stripe will not delete a Product that has Prices.

**Price changes: new Price, old one archived.** Stripe Prices are immutable, so "edit the price" is
always create-and-repoint. Any admin UI that presents it as an edit is lying about what Stripe
allows.

**Existing subscribers migrate at next renewal**, no proration. The migration is deliberately **not
a stored job**. Each Subscription records the Stripe Price it is actually on (`stripePriceId`, added
to the schema by this ticket), so the outstanding work is a query:

```
subscriptions WHERE status = 'ACTIVE'
  AND stripePriceId <> its plan's current stripePriceId
```

Idempotent, resumable, and self-healing by construction — a failed Stripe call mid-batch simply
leaves the row in the result set next run. This is what makes the "loop can break halfway" risk of
this option tractable.

**A trap avoided by choosing next-renewal over immediate proration:** with
`proration_behavior: 'none'` Stripe raises no immediate invoice, so no `invoice.paid` with
`billing_reason=subscription_update` fires. Under the immediate-proration option, every existing
subscriber would have received a full month of credits from the §6 allocation rule — a price change
would have become a mass credit giveaway.

**Decided without asking, being forced:** internal identity is the plan `code`, never the Stripe
Price ID, because Price IDs differ between test and live mode. Credit entitlement changes apply from
the next allocation and are never retroactive. The catalog is enumerated from local records rather
than by listing Stripe Products — which is what makes the nine junk Products in the account
harmless.

**Also settled here (Prisma 7):** `prisma.config.ts` was created because Prisma 7 removed the
`url` and `directUrl` datasource properties from `schema.prisma`. It points at `DIRECT_URL`, since
migrations must not run through PgBouncer. The runtime driver adapter question is unconfirmed and
recorded on ticket 001.
