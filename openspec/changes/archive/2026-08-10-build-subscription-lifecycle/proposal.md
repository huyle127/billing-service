## Why

Nothing moves a subscription's status today — registration writes `ACTIVE` and the reconciler
attaches Stripe ids. Tickets 026 and 027 are handlers with no transition to call, and §4 puts the
five states under our control rather than Stripe's. Implements **025 Build the subscription
lifecycle state machine** (`docs/wayfinder/tickets/025-build-subscription-lifecycle.md`).

## What Changes

- **A pure transition table over all five states, every effect wired** — activate, renew, cancel,
  past-due, expire. No rule reads `stripeStatus`; it stays stored verbatim for reconciliation.
- **An illegal or late transition is a silent no-op** — no status write, no `SubscriptionEvent`.
  That is what lets 026's shuffled replay converge; throwing would turn Stripe's ordinary
  redelivery into a `FAILED` row.
- **Cancel keeps the row current**, inside the one-current-subscription partial index, so access
  and credits run to period end.
- **Expire forfeits and downgrades in one transaction**: a `RESET` empties the subscription
  ledger, then a Free `Subscription` is written with `stripeSubscriptionId = NULL`. The Pro row
  leaves `CURRENT` before the Free row enters it, or the partial unique index rejects the write.
  **It allocates nothing** — 023's reconciler creates the $0 Stripe subscription and `invoice.paid`
  (027) grants the Free credits.
- **One owner for subscription credit allocation.** A new service owns "grant this subscription's
  credits for this month", idempotent on the existing month key, and
  `EntitlementService.grantOnRegistration` is refactored onto it — so 027 and 028 are born with
  one caller of `credit.allocate` rather than four.
- **Past-due owns the wallet freeze and resolution owns the unfreeze**, both inside the
  transaction that moves the status.
- **Not shipped: `CANCELED → ACTIVE`** — `SubscriptionEventType` has no value for a resume and
  ticket 031 owns self-service. **No schema change and no migration.**

## Capabilities

### New Capabilities

- `subscription-lifecycle`: which transitions exist, what each writes, and what an unasked-for one does.

## Impact

**Clauses moved off `todo`**, verbatim — §3: `Expired Pro subscription spawns a new Free
subscription`, `Subscription credits are forfeited when a subscription expires`; §4: `Lifecycle
states are set by this service, not mirrored from Stripe`, `Cancel keeps access until period
end`; §6: `Wallet freezes when a subscription goes past due`, **taken over from ticket 027**,
whose clause list loses that row; §10: `Subscription events recorded for reconciliation`.
`Resolving past due unfreezes and allocates the next period` stays `todo` for 027 — this change
unfreezes but never allocates.

**Test budget — 6 new tests**, under the ceiling of 10. **Code**: `src/billing/services/`,
`src/billing/repositories/subscription.repository.ts`, `src/billing/billing.constants.ts`,
`src/billing/billing.module.ts`. **Unblocks** 026, 027 and 031.
