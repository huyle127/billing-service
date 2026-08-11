## Context

Ticket 029 closes the business rules — Stripe owns price, we own entitlement; Prices are immutable;
migration is derived from state. They are not restated here. What is left open is where the Product
identity lives, what the reconciler's caller is, and what archiving a plan someone is on means.

## Goals / Non-Goals

**Goals:**

- A catalog readable publicly and writable by an admin, whose reads never touch Stripe.
- A price change that returns immediately and converges without ever granting a credit.

**Non-Goals:**

- Billing history in the admin view — ticket 033. Self-service plan change (031) and add-on
  purchase (032). Nothing here reads a user's own token.

## Decisions

**`stripeProductId` is nullable and the seeded rows keep it null.** The three seeded plans were
created by hand in ticket 002 and their Products are not recorded anywhere we can derive. A required
column would need a fabricated backfill, and a fabricated Product ID is worse than an absent one —
it would be handed to Stripe on the next `createPrice`. The visible consequence: creating a new
cycle for the seeded `pro` code mints a second Product rather than reusing the first. Product
identity is invisible to every route in this service, so the duplicate costs a Stripe row and
nothing else, and the first admin-created plan of any code records its Product correctly.

**The price idempotency key gains the interval.** `IDEMPOTENCY_KEYS.price(code, unitAmount)` cannot
tell `pro` monthly at $20 from `pro` annual at $20, and Stripe answers a repeated key with the
*first* object it created — so the annual price would silently come back as the monthly one. The
schema has said this all along with `@@unique([code, cycle])`; the key had not caught up.

**Archiving a plan an `ACTIVE` subscription points at is refused, `409 PLAN_IN_USE`.** Ticket 029 is
silent, and both readings are defensible, but an inactive plan with live subscribers breaks the
reconciler's own premise: it migrates rows to *their plan's current price*, and a plan nobody may
reprice leaves those rows on a Price that is archived in Stripe with no path forward. Refusing keeps
"archived" meaning "no subscriber depends on this". `PLAN_IN_USE` joins the `ErrorCode` union and
`PlanInUseException` sits in `billing/billing.errors.ts` beside the credit module's equivalent.

**The reconciler's only trigger is the in-process schedule.** Ticket 020's rule is to build an
operation when a caller exists, and the schedule is that caller. `POST /v1/internal/catalog/…` would
be a third internal route built against no caller of its own, and `api-surface.md` states that both
existing internal routes arrived together with ticket 028 for exactly that reason. `PATCH` returns
immediately and the schedule converges; no route changes.

**The reconciler writes `stripePriceId` on the row it just moved, inside the same unit as the Stripe
call's result.** That write is what makes the query self-clearing: the selection is
`status = 'ACTIVE' AND stripePriceId <> plan.stripePriceId`, so a migrated row leaves the result set
by construction and a run that dies mid-batch resumes from what is left. Idempotency and
resumability are one property here, not two mechanisms.

**Migration is `updateSubscription(priceId, prorationBehavior: 'none')` and nothing else.** Both
parameters already exist on `UpdateSubscriptionParams`. With no proration Stripe raises no invoice,
so no `invoice.paid` with `billing_reason=subscription_update` is emitted and ticket 026's handler
never fires. The credit ledger is protected by an absence, which is why the absence is asserted
directly rather than assumed.

**The orphan report searches Prices by the plan codes the local catalog already knows.** Stripe
search matches an exact `metadata['code']` value and has no key-exists form, so the query is built
per distinct local code. This finds the orphan that matters — a second cycle or a reprice whose
database write failed under a code already in the catalog. It cannot find one left by the very first
create of a brand-new code, because nothing local records that the code was ever attempted. Closing
that gap needs an intent row written before the Stripe call, which is a different change.

**One `CatalogService` owns plans and add-on packages.** They differ in one rule — packages have no
subscribers to migrate — and agree on the rest. Splitting by table would state Stripe-first
ordering, the idempotency key, and archive-never-delete twice.

## Risks / Trade-offs

**A batch that fails partway leaves subscriptions split across two prices** → that is the intended
resting state, not a fault: each row records the Price it is on, so the next run picks up exactly
the remainder. Asserted by running twice.

**A reprice between a read and the reconciler's write moves a row to the older price** → the next
run corrects it: the comparison is always against the plan's current value, not the run's.

**Schema change.** Nullable `stripeProductId` on `Plan` and `AddonPackage`, shipped as a migration
generated with `prisma migrate diff --from-config-datasource --to-schema`, applied with `deploy`.
