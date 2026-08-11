## Context

The `/v1/me` surface is the first place a user acts on their own billing state, so it is also the
first place three rules that were only ever read by webhook code have to be written by a request:
one current subscription per user, entitlement that follows the plan rather than the money, and a
wallet that no route may leave in a state the ledger cannot explain. Everything else this change
needs is already closed — provisioning by [023](../../../docs/wayfinder/tickets/023-build-registration-provisioning.md),
the state machine by [025](../../../docs/wayfinder/tickets/025-build-subscription-lifecycle.md),
`billing_mode` by [034](../../../docs/wayfinder/tickets/034-determine-stripe-billing-mode.md).

## Goals / Non-Goals

**Goals:** the seven `/v1/me` routes, the two `payment_method` handlers, and the two lifecycle edges
they need.

**Non-Goals:** add-on purchase ([032](../../../docs/wayfinder/tickets/032-build-addon-purchase.md)),
billing history ([033](../../../docs/wayfinder/tickets/033-build-billing-history.md)), and any
Stripe Checkout or Billing Portal hosted flow — the card is tokenised client-side and only its id
reaches this service.

## Decisions

**Superseding Free is a lifecycle concern, not the caller's.** `SubscriptionLifecycleService` ends
the user's current subscription when a `PENDING` one activates, inside the transaction that
activates it. Putting it in the caller would mean every activation path — `invoice.paid`,
`customer.subscription.updated`, and any later one — had to remember; putting it here means the
partial unique index is satisfied by construction. It cannot reuse the existing `expire` event,
because that path calls `replaceWithFree` and would mint a second current row against the row just
activated.

**The wallet is reset before the new allocation, not after.** Ordering is the whole decision: the
paid plan's grant is an `allocate` under the wallet lock, and a `reset` landing after it would
delete credits the user has just paid for. The reset is the same `CreditService.reset` the `EXPIRED`
transition already calls, so the ledger records the same pair of rows it always has.

**A downgrade is held locally and pushed to Stripe at once.** `updateSubscription` with
`prorationBehavior: 'none'` moves the subscription item onto the cheaper price without invoicing, so
Stripe bills the new price at renewal and the current period stays paid — the same mechanism ticket
[008](../../../docs/wayfinder/tickets/008-decide-plan-configuration.md) chose for price migration.
What must not move is `planId`, because entitlement is ours and the user has paid for this period's
credits. `pendingPlanId` and `pendingCycle` hold the target until the renewal applies it. An upgrade
has no such split: money and entitlement both move now, with `create_prorations`.

**Two readers of `stripePriceId` have to learn about a held downgrade.** `SubscriptionSyncService`
must not map the retrieved price back to a plan while that price is the pending one, or the
`customer.subscription.updated` that the push itself emits would apply the downgrade immediately.
`SubscriptionRepository.findMispriced` must exclude rows holding a pending change, or the catalog
reconciler would read the deliberate mismatch as drift and migrate the subscription back onto the
plan it is leaving. Both are one predicate each, and both fail silently if forgotten.

**Resume is an edge, not a new route.** `POST /v1/me/subscription` naming the plan a `CANCELED`
subscription is already on clears `cancel_at_period_end` at Stripe and applies a `resume` event
carrying `CANCELED → ACTIVE`. That needs `cancelAtPeriodEnd` on `UpdateSubscriptionParams`; it does
not need a seventeenth adapter operation.

**The last card is refused before Stripe is called.** Detaching it while a subscription is `ACTIVE`
or `PAST_DUE` guarantees the next renewal fails and freezes the wallet, so the service refuses with
`400` rather than letting the user arrange their own `PAST_DUE`. Free has nothing to renew, so the
guard reads the subscription status, not the presence of a subscription.

**Schema change.** `Subscription` gains `pendingPlanId String?` and `pendingCycle BillingCycle?`,
shipped as a migration generated with `prisma migrate diff --from-config-datasource --to-schema` and
applied with `prisma migrate deploy`. `PaymentMethod` is not touched — it already holds only the
reference, brand, last4 and expiry, which is what the Section 10 clause is asserted against.

## Risks / Trade-offs

- A held downgrade lives on the row with no expiry → it is cleared by the renewal that applies it,
  and by cancellation, so it cannot outlive the subscription that carries it.
- The Stripe push happens before the local write, so a crash between them leaves Stripe on the new
  price and the row holding no pending change → the catalog reconciler already corrects exactly this
  shape of drift on its next sweep.
- Two writers can activate the same `PENDING` subscription concurrently → the supersession runs
  under the same wallet lock as the allocation, and the partial unique index refuses the loser.
