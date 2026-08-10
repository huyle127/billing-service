## Context

Ticket 024 gave `WebhookHandler` the shape `handle(tx, event)` and the pipeline calls it with the
transaction already open. Ticket 026 requires the Stripe re-fetch to happen *before* the transaction
opens, so the contract cannot survive contact with the first real handler.

## Goals / Non-Goals

**Goals:** the subscription and customer handlers, the four ordering guards, and the `PAST_DUE`
unfreeze edge ticket 026 left open.

**Non-Goals:** the invoice path, `PaymentTransaction`, `paidThroughAt` and every Section 6 clause —
they are the second change. `payment_method.*` is ticket 031.

## Decisions

**The handler contract shrinks to one method, `resolve(event)`, whose resolution carries its own
`apply(tx)`.** Re-fetching happens in `resolve`, outside the transaction; a handler that finds no
subject returns the deferral there, so nothing opens a transaction it will only roll back. Carrying
`apply` as a closure over what was fetched beat a second abstract method taking the subject, which
would have forced the registry to hold `WebhookHandler<unknown>` and lost the type on the way in.
Each handler opening its own transaction was rejected outright: the pipeline would lose the one
place that maps an outcome onto the `WebhookEvent` row, which is the whole of ticket 024's spec.

**The matching, the guard and the plan lookup live in one `subscription-sync.service.ts` under
`billing/webhook/services/`, not in the handlers.** All three subscription handlers match by
`metadata.subscriptionId`, compare the period end, and re-point `planId`; one file per event type is
the repository's rule for *dispatch*, and duplicating the guard across three files is how one of the
three later loses it. It sits on the webhook side because it speaks deferrals, so every dependency
runs webhook → billing and nothing points back.

**The monotonic marker is a new nullable `Subscription.stripePeriodEnd`, not `paidThroughAt`.** The
two carry different facts: `paidThroughAt` is the boundary we have been *paid* through, written from
`invoice.period_end` by the second change and read by the cron in ticket 028, while the marker is
only a version stamp on Stripe's view of the subscription — `customer.subscription.updated` arrives
for changes where no money moved. Naming one column for both would make the cron read a boundary
nobody paid for. **Schema change:** the column ships as a migration generated with
`prisma migrate diff --from-config-datasource --to-schema` and applied with `prisma migrate deploy`.

**The wallet unfreezes on every edge leaving `PAST_DUE`, in the transition and not in a handler.**
Ticket 026 left the choice open and ticket 025 had shipped only `PAST_DUE → ACTIVE`. `PAST_DUE →
EXPIRED` is not an edge case: it is the *normal* end of dunning, since Stripe reporting `canceled`
is our `expired` ([013](../../../docs/wayfinder/tickets/013-decide-stripe-status-mapping.md)), so the
common path was the broken one — Free credits granted into a wallet nothing would thaw.

**`customer.updated` gets no handler.** Its only content we would act on is the default payment
method, which ticket 031 owns; a handler with an empty body reads as support that is not there. Same
rule that moved the internal key from 023 to 028.

**The account's post-retry behaviour is set to `Cancel subscription`.** Ticket 013 noted the setting
cannot be read at runtime and ticket 002 never recorded it. Left on `unpaid`, Stripe emits no
`customer.subscription.deleted`, nothing drives `expire`, and a past due subscription sits frozen
forever — the one Dashboard value that makes the path above unreachable.

## Risks / Trade-offs

**The convergence test proves ordering only over the events this change handles.** A history without
`invoice.paid` never exercises activation or allocation, so the clause "Replaying full history
converges on the ordered result" stays `todo`; the second change extends this test rather than
writing a second one, which is why the split was drawn here.

**`resolve` re-fetches on every delivery, including duplicates Stripe sends by design.** That is one
extra API call per redelivered event, accepted because the alternative is trusting a payload the
ticket's central rule says not to trust.
