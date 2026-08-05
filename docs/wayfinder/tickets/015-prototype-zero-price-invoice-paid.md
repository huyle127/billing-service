# 015 Prototype: does a $0 recurring price emit monthly `invoice.paid`?

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:prototype -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

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

**Confirmed: a $0 recurring price generates an invoice and emits `invoice.paid` every month.**

Probed against `price_1TyShMFaNFL0w4nvycCBFDng` with a Stripe test clock, advancing three monthly
periods.

| Point in time | Invoice | `billing_reason` | `invoice.paid` |
| --- | --- | --- | --- |
| Subscription created | yes | `subscription_create` | fired |
| Month 1 | yes | `subscription_cycle` | fired |
| Month 2 | yes | `subscription_cycle` | fired |
| Month 3 | yes | `subscription_cycle` | fired |

The subscription remained `active` throughout and the item period advanced by one month each time.
Four invoices for creation plus three cycles — exactly one per period, no gaps.

**This validates ticket 014.** Free was decided to be a real Stripe subscription before this
evidence existed; the assumption underneath it holds. Free-tier credits ride on `invoice.paid` and
need no separate cron.

### Findings that change how the code must be written

**`invoice.paid` as a boolean field is gone.** The probe read `invoice.paid` and got `undefined`
while `invoice.status` was `'paid'`. Recent API versions removed the field — consistent with ticket
003's finding that Basil restructured Invoice.

This is a silent failure waiting to happen: `undefined` is falsy, so `if (invoice.paid)` never
grants credits and never raises an error. **Check `invoice.status === 'paid'`.** The event type
`invoice.paid` still exists and fires normally; only the object field is affected.

**`current_period_start` and `current_period_end` are on the subscription item**, not the
subscription. Confirmed directly — the probe read them from `subscription.items.data[0]`. This is
ticket 003's implication A observed rather than inferred.

**`invoice.upcoming` fires on each cycle** and is not in the eight core events listed in
requirements §5. Harmless, but it will appear in the `WebhookEvent` table if subscribed to.

**`invoice.payment_succeeded` fires alongside `invoice.paid`** even for zero-amount invoices where
no money moved. Both must not independently trigger allocation — the allocation key from ticket 016
already covers this, but it is worth knowing the pair arrives together.

### Method note

Test clocks worked as documented and were adequate for this. The probe deletes its clock at the
end, which removes the associated customer and subscription.
