# 015 Prototype: does a $0 recurring price emit monthly `invoice.paid`?

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:prototype -->
<!-- mode: HITL -->
<!-- status: open -->
<!-- assignee: -->
<!-- blocked-by: 002 -->

## Question

Verify empirically whether a $0 recurring Stripe price generates a monthly invoice and a monthly
`invoice.paid` event, for the whole life of a subscription.

Ticket 003 flagged this as **the single most important thing to prototype**. Stripe documents that
invoices below the minimum chargeable amount are auto-marked paid, and separately that
`invoice.paid` fires when an invoice is marked paid out-of-band — but no Stripe page states plainly
that a $0 recurring price keeps emitting `invoice.paid` month after month. Free-tier credit
allocation may rest entirely on this, so it must be confirmed, not assumed.

Method:

- A $0 monthly recurring Price **already exists** in the account: `price_1TyShMFaNFL0w4nvycCBFDng`
  on product `AI Free` (`prod_UyPWFhOF4FGfZG`), verified 2026-08-04 via ticket 002. Use it rather
  than creating a new one. Its existence is also evidence that Free was intended to be a real
  Stripe subscription — but intent is not confirmation, which is exactly what this ticket tests.
- Subscribe a test customer to that price.
- Attach a **test clock** and advance it several months.
- Record which events fire at each boundary, whether an Invoice is generated each period, and
  whether `invoice.paid` arrives every month or only on creation.
- Capture `billing_reason` on each invoice — it feeds ticket 016.
- Note the test clock's per-advance interval limit while doing this; the research reports $0
  monthly subscriptions reduce it.

Blocked by 002 only — this needs a Stripe sandbox and the CLI, not our application. It deliberately
does **not** depend on 001, so it can run before any code exists.

Deliverable: a short findings note appended to `docs/research/stripe-object-model.md` under the
unconfirmed items, or a linked file. Resolving this unblocks 014.

## Answer

_Unresolved._
