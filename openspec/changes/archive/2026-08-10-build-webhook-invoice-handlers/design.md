## Context

The processor, the ordering guards and the `resolve` / `apply(tx)` contract are settled by
`build-webhook-subscription-handlers`; the allocation owner and the transition table by
`build-subscription-lifecycle`. What is open is what an *invoice* means to us, and that is the whole
of this design. Ticket 016 closed *when* a grant is owed — `billing_reason`, not `invoice.paid`
alone — and ticket 015 closed how payment is detected. Neither is re-opened here.

## Goals / Non-Goals

**Goals:**

- One reading of an invoice that both handlers share, so the money rules live in one place.
- A grant that lands on the same key however late or often the event arrives.
- The `PaymentTransaction` row that a failed-then-paid invoice needs, under its unique constraint.

**Non-Goals:**

- The annual catch-up loop across missed months (028) and add-on purchases (032).
- Any schema change. `paidThroughAt`, `nextCreditAt` and `PaymentTransaction` all exist; **this
  change ships no migration.**

## Decisions

**The month key comes from the invoice's `period_start`, never the clock.** A redelivery three weeks
late, or a shuffled replay, must produce the same `ALLOCATION_KEYS.month` as the first delivery, or
the convergence test this ticket rests on cannot hold. Keying on the clock would grant a second
month's credits to any event that crossed a month boundary before being processed — a silent
double-grant, which is the failure ticket 014 caught before it shipped. This requires `periodStart`
on `StripeInvoice`, alongside the `billingReason` the grant rule needs; both are plain domain values
on the adapter seam, per ticket 019.

**Activation is an edge in the table, not a branch in the handler.** `PENDING + renew → ACTIVE`
recording `CREATED` is added, so the handler always requests `renew` and the table decides whether
that means activating a 3DS-held subscription or renewing a running one. The alternative — the
handler reading our status and choosing between `activate` and `renew` — puts a lifecycle decision
outside the table that ticket 025 built to hold all of them, and the transition test would no longer
cover it.

**The `PaymentTransaction` is upserted on `stripeInvoiceId`, not inserted.** A dunning sequence is
`payment_failed` then `paid` for *one* invoice, and the column is unique, so a second insert throws
and turns an ordinary recovery into a `FAILED` webhook. The row moves `FAILED → SUCCEEDED` in place.
Zero-amount invoices write no row at all — no money moved — which is also what keeps the Free tier
off the payment history.

**`nextCreditAt` is written here, by the allocator, for annual subscriptions only.** Ticket 028's
cron scans `status = ACTIVE AND nextCreditAt < now`; if this change left the column null, 028 would
open with a backfill over every annual subscription already sold. Monthly subscriptions get their
next grant from the next `invoice.paid`, so the column stays null for them and the cron's index
stays small — which is the same reason the sync backlog indexes are partial.

**Resolution unfreezes through the transition, and allocates as an ordinary grant.** `invoice.paid`
against a `PAST_DUE` subscription requests `renew`; the wallet thaw rides inside that transition
(025), and the allocation is the same month-keyed grant every other paid invoice makes. There is no
separate resolution path.

## Risks / Trade-offs

- **The grant rule reads a Stripe string** (`billing_reason`) → it is the one Stripe value a business
  rule may branch on, because it describes why *Stripe* issued the invoice, not what state we are in;
  the rule is asserted directly by a test over the three granting reasons and one refused one.
- **Extending the existing convergence test rather than adding one** keeps the budget at six but
  makes that test the single point of failure for eleven clauses → it asserts final rows, so a
  regression anywhere in the pipeline surfaces there rather than being missed.
