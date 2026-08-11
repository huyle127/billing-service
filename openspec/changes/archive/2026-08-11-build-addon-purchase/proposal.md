## Why

Implements wayfinder ticket [032](../../../docs/wayfinder/tickets/032-build-addon-purchase.md).
Add-on packages can be listed and administered today, but nobody can buy one — and this is the
only path that grants credits with no subscription behind it.

## What Changes

- `POST /v1/me/addons/purchase` names a package code, provisions defensively, and charges the
  caller's default card through `createOneTimePayment`, callerless since 019.
- A `PaymentTransaction` row is written `PENDING` **before** Stripe is called, carrying the new
  `addonPackageId` column; its id is the `purchaseId` the PaymentIntent is keyed on.
- Credits are granted only by `payment_intent.succeeded`, which writes the `ADDON` allocation and
  settles the payment row in one transaction. `payment_intent.payment_failed` marks it `FAILED` and
  grants nothing. A `requires_action` intent leaves the row `PENDING` and the wallet untouched.
- Purchasing is refused while the wallet is `FROZEN` — a rule §7 does not state, argued in the design.

## Capabilities

### New Capabilities

- `addon-purchase`: buying a fixed credit package, and the grant that follows payment confirmation.

### Modified Capabilities

- `webhook-handlers`: two `payment_intent` events join the registry and carry the add-on grant.

## Clauses closed

`requirement-coverage.md` has **no Section 7 table**, so this change adds it, then satisfies every
row: `Additional credits are purchased in fixed packages` · `Add-on payments are processed through
Stripe` · `Credits are granted only after successful payment confirmation` · `Add-on transactions
are recorded` · `A purchase is refused while the wallet is frozen`. Section 5 gains `Processing
add-on credit purchase payments`. Refundability is untracked — §11 excludes the workflow.

## Test budget

6 new tests, under the ceiling: purchase grants nothing on its own, a succeeded intent grants and
settles in one transaction, a replayed succeeded intent grants once, a failed intent grants nothing,
a frozen wallet is refused before Stripe is called, and two purchases of one package both land.
