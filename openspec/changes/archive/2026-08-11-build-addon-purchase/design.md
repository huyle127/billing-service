## Context

Every allocation this service has written so far hangs off an invoice: a subscription period paid,
credits granted, keyed on the period. An add-on purchase has no subscription and no period, so it is
the first grant that has to carry its own identity, and the first money path where the request that
takes the money and the event that hands over the goods are separate transactions. The adapter
operation it needs — `createOneTimePayment`, a PaymentIntent confirmed `off_session` and keyed on a
`purchaseId` — was built by [019](../../../docs/wayfinder/tickets/019-build-stripe-adapter.md) and
has been callerless since. Provisioning is closed by
[023](../../../docs/wayfinder/tickets/023-build-registration-provisioning.md), the ledger's add-on
rules by [022](../../../docs/wayfinder/tickets/022-build-credit-allocation-and-freeze.md), and the
package catalog by [029](../../../docs/wayfinder/tickets/029-build-plan-catalog-admin.md).

## Goals / Non-Goals

**Goals:** one route, two `payment_intent` handlers, and the local row that ties them together.

**Non-Goals:** refunds, which §11 excludes and Stripe will not perform unasked; a 3DS continuation
flow, which needs a frontend; a sweeper for purchases Stripe never resolves; and any change to how
the ledger itself treats add-on credits.

## Decisions

**A local `PaymentTransaction` is written `PENDING` before Stripe is called, and it is what says how
many credits are owed.** The alternative was to carry the package id in the PaymentIntent metadata
and read it back in the handler, which is less code and no local row. It was rejected because the
number of credits a user has paid for would then exist only in Stripe: a purchase that fails, or one
whose intent needs authentication, would leave nothing locally to look at, and there would be no row
for billing history ([033](../../../docs/wayfinder/tickets/033-build-billing-history.md)) to read.
Writing money-owed state before taking the money is also the only order in which a crash mid-call is
recoverable — the row is the record that a charge was attempted.

**The grant is keyed on the purchase, not the package and not the intent.** `CreditTransaction`'s
`@@unique([idempotencyKey, ledger])` is the only thing standing between a redelivered
`payment_intent.succeeded` and a second grant of credits nobody paid for, so the key has to be
stable across redeliveries and distinct per purchase. The purchase row's id is both; the package
code is neither, and keying on it would silently collapse a user's second purchase of the same
package into a replay of the first. The intent id is stable too, but the purchase id is ours and is
already the idempotency key the adapter derives for Stripe, so one identifier does both jobs.

**Only the handler grants.** The request path creates the intent and returns; it never touches the
wallet, whatever status Stripe answers with — including `succeeded`, which an `off_session` confirm
can return in the same call. This is §7's one rule that can lose money, and the way to not get it
wrong is for the request path to contain no grant at all rather than a grant behind a condition. The
handler does the grant and the settle of the payment row in a single transaction, so credits and the
money record can never disagree.

**`requires_action` is a resting state, not an error.** The intent stays open at Stripe, the local
row stays `PENDING`, the response reports the status, and nothing is granted. If the user completes
authentication elsewhere, the `succeeded` event arrives later and the `PENDING` row is exactly what
it needs to find. Treating it as a `400` would discard that row and leave a later `succeeded` event
with nothing to resolve against, which is the one failure shape here that ends with a paying user
holding no credits.

**A `FROZEN` wallet refuses the purchase, before Stripe is called.** This rule is not in §7 and is
not derivable from it — it was decided at propose time for this ticket. A `PAST_DUE` user's credits
are unspendable until the arrears clear, so taking money for more of them is the wrong answer to
their actual problem. It does not contradict `credit-ledger`'s "a freeze gates consumption only":
the ledger still accepts allocations while frozen, and it is this flow that declines to start one.

**Handlers resolve by metadata, and defer when they cannot.** `payment_intent.succeeded` and
`.payment_failed` read `purchaseId` from the intent's metadata and load the local row; an intent
carrying no purchase id, or naming a row that does not exist, defers on the existing
`webhook-handlers` rule rather than failing. A row already out of `PENDING` is completed without
work, which is what makes redelivery cheap.

**Schema change.** `PaymentTransaction` gains `addonPackageId String?` with a relation to
`AddonPackage`, and `stripePaymentIntentId` becomes `@unique` so one intent can back at most one
payment row. Shipped as a migration generated with `prisma migrate diff --from-config-datasource
--to-schema` and applied with `prisma migrate deploy`.

## Risks / Trade-offs

- An intent left at `requires_action` keeps its `PENDING` row forever → it is visible rather than
  lost, and reconciling it is deferred with the rest of the 3DS story; no cron is added for it here.
- Stripe charges the card but our handler cannot resolve the purchase → the event defers and Stripe
  redelivers, and the `WebhookEvent` row carries the reason for as long as the row exists.
- Two deliveries of one `succeeded` event race → both take the wallet lock and the allocation key
  refuses the loser, the same protection every other allocation path relies on.
