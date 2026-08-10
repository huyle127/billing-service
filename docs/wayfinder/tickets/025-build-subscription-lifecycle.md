# 025 Build the subscription lifecycle state machine

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 022, 023 -->

## Question

The transitions, who sets them, and what each one writes.

**Test the transition table, and little else.** The map's working discipline no longer asks for
blanket TDD, but the transition function stays worth testing under the rule that replaced it: it is
pure — no database, no Stripe — and a wrong branch in a state machine fails silently rather than
loudly. One test driving the whole table, not one per transition. The handlers and wiring around it
are written without tests.

- **The states are ours.** Stripe events are inputs that trigger transitions; **no business rule
  branches on a Stripe status value.** `stripeStatus` is stored verbatim for reconciliation and audit
  only. Ticket 013 established there is no mapping to build — the mapping problem dissolved.
- Stripe's vocabulary collides with ours without matching it. A subscription Stripe reports as
  `canceled` has **already ended** — that is our `expired` — while our `canceled` is one Stripe still
  reports as `active`. Reading Stripe's status as ours is wrong by a full billing period.
- **Five states, not four.** `PENDING` was forced by ticket 013's 3DS decision and added by ticket
  007: a subscription awaiting payment authentication is recorded but **is not current**. Stripe emits
  `customer.subscription.created` before any money moves and abandons the attempt roughly 23 hours
  later with no guaranteed event telling us to revoke, so treating it as activation would grant Pro
  credits for an unpaid subscription.
- "Current" is `status IN (ACTIVE, CANCELED, PAST_DUE)`, enforced by a partial unique index that
  already exists and was verified by violation in ticket 001.
- **Cancel** → `CANCELED`; access and credits continue to period end.
- **Expire** → `EXPIRED`, subscription credits **forfeited** via a `RESET` transaction (022), and a
  **new Free Subscription created in the same transaction**. Pro → Free downgrade is the same shape.
- Every transition appends a `SubscriptionEvent` with type, reason, and the Stripe event reference,
  inside the same transaction. This is the reconciliation audit trail, so it is never an event-bus
  listener's job — ticket 004's rule is that no invariant is ever maintained by a listener.
- Webhook handlers (026) drive transitions through this state machine and never write `status`
  directly.

**Trap.** Creating the new Free subscription while the Pro row is still current violates the
one-current-subscription partial unique index. Order the writes inside the transaction so the old row
leaves `CURRENT` before the new one enters it, and assert the index actually rejects the wrong order
rather than assuming the right one.

## Requirement clauses closed

Section 3:

- Expired Pro subscription spawns a new Free subscription
- Subscription credits are forfeited when a subscription expires

Section 4:

- Lifecycle states are set by this service, not mirrored from Stripe
- Cancel keeps access until period end

Section 6, taken over from the old ticket 027 — now merged into 026 — because the freeze rides
inside the transition:

- Wallet freezes when a subscription goes past due

Section 10:

- Subscription events recorded for reconciliation
