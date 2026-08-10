## Why

Nothing grants credits from a payment yet. `build-webhook-subscription-handlers` shipped the
processor and its guards but left `invoice.*` unhandled, so a renewal moves no credits and a failed
payment freezes nothing. Second half of **026 Build the webhook handlers**
(`docs/wayfinder/tickets/026-build-webhook-handlers.md`).

## What Changes

- **`invoice.paid` and `invoice.payment_failed` handlers** on the `resolve` / `apply(tx)` contract
  the first half established. Payment is `invoice.status === 'paid'`; the removed `paid` boolean is never read.
- **Credits are granted only on `billing_reason` of `subscription_create`, `subscription_cycle` or
  `subscription_update`**, through the allocation owner, never `credit.allocate` directly.
- **The allocation key comes from the invoice's `period_start`**, not the clock, so a late or
  redelivered event lands on the same key and convergence still holds.
- **`PENDING + renew → ACTIVE` joins the transition table**, recording `CREATED`, so the first
  invoice activates a 3DS-held subscription without the handler branching on our own status.
- **`paidThroughAt` from `period_end`, and `nextCreditAt` one month past the period start on annual
  subscriptions**, so ticket 028's cron is born with rows to scan.
- **A `PaymentTransaction` per invoice, never for a zero-amount one.** `payment_failed` writes it
  `FAILED`; a later payment upserts that row to `SUCCEEDED`, as the unique `stripeInvoiceId` requires.
- **`StripeInvoice` gains `billingReason` and `periodStart`** as plain domain values on the seam.
  **Not shipped:** the annual catch-up loop (028), add-on purchases (032).

## Capabilities

### Modified Capabilities

- `webhook-handlers`: what an invoice event grants, records, and refuses to grant.
- `subscription-lifecycle`: the transition table gains the `PENDING + renew` activation edge.

## Impact

**Clauses off `todo`**, verbatim — §6: `Payment detected via `invoice.status`, never the removed
`paid` field`, `Allocation grants on `subscription_create`, `_cycle`, and `_update` only`, `Free tier
allocates monthly from `invoice.paid` with no separate cron`, `A mid-cycle plan change grants a full
new monthly allocation`, `Resolving past due unfreezes and allocates the next period`; §5: `Replaying
full history converges on the ordered result` — its test extended, not replaced.

**Test budget — 6 new tests**, under the ceiling of 10. **No schema change.** **Unblocks** 028, 032.
