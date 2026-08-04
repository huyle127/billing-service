# 013 Decide the Stripe-to-domain status mapping

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

How does Stripe's eight-value subscription status vocabulary map onto our four-value lifecycle,
and what happens to the values that do not fit?

Ticket 003 established that our current model cannot round-trip Stripe's state. This is a domain
decision, not a schema detail, and 007 depends on it.

Facts to design against (from `docs/research/stripe-object-model.md` §2 and implications B, C):

- Our `canceled` ("will not renew, access continues to period end") is Stripe's `active` with
  `cancel_at_period_end=true` — **not** Stripe's `canceled`.
- Our `expired` is Stripe's `canceled`, signalled by `customer.subscription.deleted`.
- `incomplete`, `incomplete_expired`, and `unpaid` have no home. `paused` is latent until trials.
- Whether `past_due` transitions to `canceled`, `unpaid`, or stays put is a **Stripe Dashboard
  setting we cannot read at runtime**.

Questions to resolve:

- Do we widen the domain enum to carry `incomplete` and `unpaid`, or keep four states and add a
  separate `stripeStatus` column that preserves Stripe's raw value? The research recommends one of
  these two — the current design does neither.
- **`incomplete` is the sharpest risk.** SCA/3DS makes it routine: a Pro signup pending
  authentication emits `customer.subscription.created` with `status: "incomplete"`. If we treat
  creation as activation we grant 200 credits for an unpaid subscription, and `incomplete_expired`
  arrives ~23 hours later with no guaranteed event telling us to revoke. What is the rule?
- **`unpaid`**: map to our `past-due` (freezes the wallet — behaviourally right, and reversible) or
  our `expired` (forfeits credits and spawns a Free subscription — irreversible, whereas Stripe's
  `unpaid` can return to `active`)?
- Which Dashboard setting for the `past_due` transition do we standardise on, and where is that
  recorded so the configuration drift is visible?
- Is our lifecycle state derived from Stripe on every event, or maintained independently and
  reconciled? This determines what happens when the two disagree.

Consult `/domain-modeling`.

## Answer

**The question was posed wrongly, and the answer corrects the premise.** This ticket asked how
Stripe's status vocabulary maps onto ours. It does not, and it should not: **the four lifecycle
states belong to the Billing Service and are set by it.** Stripe events are inputs that trigger our
transitions; no business rule branches on a Stripe status value. There is no mapping table.

Recorded in `docs/requirements/billing-service-requirements.md` under Subscription:

| Our state | Set when | Stripe signal that informs it |
| --- | --- | --- |
| `active` | payment for the current period is confirmed | `invoice.paid` |
| `canceled` | user requests non-renewal | `customer.subscription.updated` + `cancel_at_period_end` |
| `past-due` | a renewal payment has failed; wallet frozen | `invoice.payment_failed` |
| `expired` | period ended and will not renew | `customer.subscription.deleted` |

Consequences of owning the state rather than deriving it:

- **The three "homeless" Stripe statuses stop being a problem.** `incomplete`, `unpaid`, and
  `incomplete_expired` needed a home only under a derivation model. Under ownership they are
  observations, not states we must represent.
- **The Stripe Dashboard `past_due` transition setting no longer threatens correctness.** It cannot
  be read at runtime, but since our lifecycle is set independently, changing it cannot silently
  alter our behaviour. Still worth recording during Stripe account setup (ticket 002) so
  reconciliation knows what to expect in `stripeStatus`.
- **Recovery from `past-due`** is driven by observing a successful payment, not by Stripe returning
  the subscription to a particular status.
- **`stripeStatus` is still stored**, verbatim, but for reconciliation and audit only.

Retained unchanged: **a subscription pending 3DS/SCA authentication does not become current.** The
row is recorded, but the User's current Subscription stays as it was — typically Free — until
payment confirms. This closes the hole where creation-implies-activation would grant Pro credits
for an unpaid subscription that Stripe abandons ~23 hours later with no guaranteed revocation
event. This holds regardless of the ownership question.
