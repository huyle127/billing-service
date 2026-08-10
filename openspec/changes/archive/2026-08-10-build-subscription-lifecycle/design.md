## Context

Four call sites were on course to call `credit.allocate` for the `SUBSCRIPTION` ledger:
`grantOnRegistration` (shipped, 023), the `invoice.paid` handler (027), the annual cron (028), and
the Pro→Free downgrade this change builds. Each would carry its own copy of *how much, for which
period, under which key* — the shape that produced the double-allocation ticket 014 caught before
it shipped. This change is the first to have more than one of them in view, so it is where the
question is settled.

The lifecycle states themselves are not open: ticket 013 closed the Stripe mapping, ticket 007 the
fifth `PENDING` state and the one-current-subscription partial index.

## Goals / Non-Goals

**Goals:**

- One place decides a subscription credit grant; every trigger routes through it.
- A transition table 026 and 027 can drive without either of them writing `status`.
- Shuffled webhook replay can converge, which constrains what a late transition may do.

**Non-Goals:**

- Deciding *when* a grant is owed from a Stripe invoice — that is 016, applied by 027.
- The annual cron's catch-up loop (028) and self-service resume (031).
- Any schema change. `SubscriptionStatus`, `SubscriptionEventType`, the sync columns and the
  partial unique index all exist; **this change ships no migration.**

## Decisions

**One allocation owner, several triggers.** A new `SubscriptionAllocationService` in
`billing/services/` owns "grant this subscription's plan credits for this month", idempotent on
the existing `ALLOCATION_KEYS.month`, and is the only caller of `credit.allocate` for the
`SUBSCRIPTION` ledger. `grantOnRegistration` is refactored onto it in this change rather than in
027, so the second and third triggers are written against an owner that already exists instead of
against `credit.allocate`. Making the `invoice.paid` handler the *only* allocator was considered
and rejected on two facts: Stripe emits one `invoice.paid` a year for an annual plan while credits
are monthly (028), and registration must grant while Stripe is unreachable (023).

**The transition table is a pure function file, not a service.**
`services/subscription-transitions.ts` holds `(from, event) → to` and the `SubscriptionEventType`
each edge records, with no injection and no database, following the `credit/services/draw-split.ts`
precedent. It is the one part of this change that can hold a wrong branch silently, and keeping it
free of a Nest container is what lets one test drive the whole table.

**An unrepresentable transition returns `unchanged`, it does not throw.** Stripe redelivers
normally and gives no ordering guarantee (017), so `customer.subscription.deleted` arriving against
an already-`EXPIRED` row is ordinary traffic, not an error. `unchanged` writes no status and appends
no `SubscriptionEvent` — appending one would make the audit trail depend on delivery order, and
throwing would make every such redelivery a `FAILED` row. This is the precondition 026's
shuffled-replay test rests on.

**The wallet freeze rides inside the transition.** `→ PAST_DUE` freezes and `PAST_DUE → ACTIVE`
unfreezes, in the transaction that moves the status, because a wallet whose frozen-ness can lag the
subscription is a state requirements §6 does not describe. The *allocate* half of resolution stays
with 027 — it needs the invoice to know the period, which the lifecycle machine never sees.

**The downgrade writes `EXPIRED` before it writes the Free row.** Both `CANCELED` and `ACTIVE` sit
inside the partial unique index, so creating the Free subscription first violates it. The order is
asserted by attempting the wrong one and expecting the database to reject it, not by trusting the
statement sequence.

**`SubscriptionEvent` folds into `subscription.repository.ts`.** It has no lifecycle apart from the
subscription it hangs off and is only ever written in the same transaction, so a second repository
would be a second name for one aggregate.

**`CANCELED → ACTIVE` is left out.** `SubscriptionEventType` carries no value for a resume, adding
one is a migration, and ticket 031 owns self-service — so the edge is built by the ticket that has
a caller for it.

## Risks / Trade-offs

- **A silent no-op hides a genuine bug in the table** → the transition test drives every
  `(from, event)` pair including the rejected ones, so a mis-declared edge fails there rather than
  disappearing into production.
- **Refactoring shipped registration code widens this change** → it is one call site swap, and the
  existing registration tests plus one new test assert the grant still lands exactly once under the
  same key.
- **The new Free subscription holds no credits until Stripe answers** → accepted deliberately; the
  alternative reintroduces a second allocator for the gap between downgrade and the $0
  `invoice.paid`.
