# 007 Design the persistence schema

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- output: prisma/schema.prisma, prisma/sql/constraints.sql -->
<!-- blocked-by: -->

## Question

What is the full Prisma schema — tables, columns, types, indexes, and constraints?

Blocked by 003 because the Stripe object mapping determines which Stripe references each table
must hold, and by 004 because module boundaries determine which module owns which table.

Questions to resolve:

- **Money and credit representation.** Both must be integers — cents and whole credits, never
  floats. Confirm the types and confirm Prisma maps them as intended on Postgres.
- **Subscription history.** The domain model says an expired Pro subscription row is kept and a
  new Free row created, so subscriptions are append-only rows rather than one mutable row per
  user. How is "the current subscription" then identified, and what constraint enforces
  requirements §3's rule of exactly one current subscription per user?
- **Wallet and ledgers.** Are Subscription Credits and Add-on Credits two columns on one wallet
  row, or two ledger rows? This interacts directly with the locking strategy from 006.
- **Balance integrity.** Is the balance a stored column, or derived by summing `CreditTransaction`
  rows? Stored is fast but can drift; derived is always correct but costly. If stored, what
  reconciles it against the transaction log?
- **Non-negative enforcement** at the database level, not only in application code.
- **`WebhookEvent` as a queue table.** Requirements §5 mandates Stripe event ID, event type, raw
  payload, status, retry count, and failure reason. Add what the queue needs: a next-attempt
  timestamp, and the indexes that make `FOR UPDATE SKIP LOCKED` polling efficient. A unique
  constraint on the Stripe event ID is what actually delivers idempotency.
- **`SubscriptionEvent`** and its Stripe event reference, for the reconciliation requirement.
- Where the `nextCreditAt` field driving the annual cron lives, and how catch-up allocation stays
  idempotent (requirements §3).
- Migration strategy on Neon given the pooled versus direct URL split.

Added from ticket 003's findings:

- **A `stripeStatus` column**, if ticket 013 chooses to preserve Stripe's raw status alongside our
  own lifecycle state rather than widening the domain enum.
- **The paid-through boundary.** `current_period_end` no longer exists on the Stripe Subscription
  object, so the cron cannot read it there. Persist the boundary ourselves — most likely from
  `invoice.period_end` on the `invoice.paid` we already handle — and record the
  single-subscription-item assumption this relies on.
- **`PaymentMethod` keyed by Stripe payment method id.** The `customer` field on a PaymentMethod is
  null once detached, so a `payment_method.detached` webhook is unresolvable if our rows are keyed
  only by Stripe customer. Store the `pm_…` to user mapping locally.
- **The allocation idempotency key from ticket 016** — likely invoice id plus billing period — needs
  a unique constraint, not just application logic, to survive concurrent processing. This is
  separate from the `WebhookEvent` unique constraint on Stripe event id.
- **Proration credits are not payments.** Stripe issues `CustomerBalanceTransaction` credits, not
  refunds. If we model them at all, they need their own ledger rather than negative
  `PaymentTransaction` rows.

Consult `/domain-modeling`.

## Answer

Written to `prisma/schema.prisma` and `prisma/sql/constraints.sql`.

**Wallet shape: one row, two columns.** `CreditWallet` holds `subscriptionCredits`,
`addonCredits`, and `status`. Consumption locks a single row, decrements both columns in draw
order, and writes the `CreditTransaction` in the same transaction. Two ledger *rows* were
considered and rejected: they force locking two rows in a fixed order to avoid deadlock, and buy
only extensibility to a third ledger type that the domain does not have. Deriving balances by
summing transactions was also rejected — always correct, but it degrades with history and cannot be
protected by a `CHECK` constraint, pushing the non-negative invariant back into application code.

**A fifth subscription state: `PENDING`.** Ticket 013 decided that a subscription awaiting 3DS/SCA
does not become current. That decision has a schema consequence that was not visible when it was
made: such a row is not `ACTIVE`, `CANCELED`, `PAST_DUE`, or `EXPIRED`, so the four-value enum had
nowhere to put it. `PENDING` is our own state, not a mirror of Stripe's, so it remains consistent
with the principle that the lifecycle belongs to this service.

"Current" is then `status IN (ACTIVE, CANCELED, PAST_DUE)`, enforced by a partial unique index on
`user_id`. One source of truth — rejected alternatives were an `isCurrent` boolean (two columns that
can contradict each other, and the pending row still needs a status) and a
`User.currentSubscriptionId` pointer (would require the `user` module to own a column the `billing`
module drives, breaking table ownership and creating a dependency cycle).

**Money and credits are integers throughout** — cents and whole credits, never floats.

**Constraints Prisma cannot express** live in `prisma/sql/constraints.sql`: non-negative balance
checks, the one-current-subscription partial unique index, and non-negative catalog amounts. These
must be appended to the initial migration. They are the invariants that survive concurrency;
application-level checks alone do not.

**Allocation idempotency** — superseded by ticket 014. This ticket originally chose a composite
unique `(stripeInvoiceId, periodStart)`. That proved insufficient once Free became a real Stripe
subscription: the registration grant and the annual cron both allocate with no invoice at all, and
Postgres treats NULLs as distinct, so duplicates would have been accepted. The constraint is now a
unique on **`allocationKey`**, an opaque string identifying the subscription and the month, supplied
by the caller. It is deliberately not a foreign key — the credit module is a leaf and must not know
subscriptions exist. NULL-distinctness is still load-bearing, since consumption and adjustment rows
carry no key.

**Other decisions recorded in the schema:**

- `paidThroughAt` on Subscription is the boundary we own, written from `invoice.period_end`, since
  `current_period_end` no longer exists on the Stripe Subscription object (ticket 012).
- `stripeStatus` is a nullable string, stored verbatim for reconciliation only.
- `PaymentMethod` is keyed by `stripePaymentMethodId` with its own `userId`, so a
  `payment_method.detached` webhook remains resolvable after Stripe nulls the customer field.
- `WebhookEvent` carries `nextAttemptAt` and an index on `(status, nextAttemptAt)` to serve the
  `FOR UPDATE SKIP LOCKED` poll.
- No unique constraint on `subscriptions.stripeSubscriptionId` — expired rows are retained and the
  same Stripe id can appear on more than one row across a plan change.

**Provisional pending ticket 008:** `Plan` and `AddonPackage` are modelled as local tables carrying
`stripePriceId`. That mapping is required under every option 008 might choose; what 008 still
decides is who is authoritative for the values and whether admin edits write to Stripe.
