# 017 Design out-of-order webhook handling

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

How does the webhook processor stay correct when events arrive out of order?

Requirements §5 covers idempotency, retries, and dead-lettering, but says nothing about ordering —
and ticket 003 established that **Stripe explicitly does not guarantee it**. This is a genuine gap
in the specification, not an implementation detail.

Concrete failures to design against:

- `invoice.paid` arrives **before** the `customer.subscription.updated` that made the subscription
  active — credits get allocated against a row that still says `past-due`, or against a
  subscription row that does not exist yet.
- `customer.subscription.deleted` (Pro expiry) arrives **before** a final `invoice.paid`.

Questions to resolve:

- Stripe's documented mitigation is to **re-fetch the object from the API on receipt** rather than
  trusting the payload. Do we adopt that? It costs a network call per event and makes the processor
  dependent on Stripe availability, but it removes a whole class of ordering bug.
- Alternatively, a monotonic guard: the research notes
  `subscription.items.data[].current_period_end` is a natural version marker. Is that sufficient
  alone, or only as a complement?
- What does the processor do with an event it cannot yet apply — defer and retry via the existing
  queue, or apply speculatively? The retry machinery from requirements §5 already exists, so
  deferral may be nearly free.
- Requirements §5's phrase "processed atomically at the Subscription aggregate level" is
  *compatible* with ordering-independence but does not deliver it. Restate that requirement once
  this is decided.

Blocked by 004 because the answer determines where the re-fetch or guard sits in the layering, and
who owns the Stripe adapter call.

## Answer

Requirements §5 now carries an **Event ordering** section stating plainly that Stripe does not
guarantee ordering and that processing must never assume it. Four rules were adopted:

1. **Re-fetch on receipt.** The affected Stripe object is fetched from the API and current state
   applied; the payload is a notification that something changed, not the authority on what it
   changed to. This is Stripe's documented mitigation. Accepted cost: one network call per event,
   and a processing dependency on Stripe availability — mitigated by the fact that failures land
   in the existing retry queue rather than being lost. *(Amended by requirements §5 on 2026-08-09 —
   processing became synchronous, so a deferred event is answered non-2xx and Stripe redelivers it.
   The rule that deferral must stay distinguishable from failure survives; the queue it named does
   not. See ticket 024.)*
2. **Monotonic guard.** Period-derived state only advances, never regresses, so a late stale event
   cannot roll a subscription backwards. The subscription item's period end is the version marker.
3. **Defer, do not fail**, when an event's subject does not exist locally yet. The existing retry
   machinery covers this at no extra cost, but deferrals must be distinguishable from genuine
   failures so they do not burn the retry budget and land in the DLQ spuriously.
4. **Two-layer idempotency**, cross-referenced to the allocation key in ticket 016.

Also recorded: replaying the full event history must converge on the same result as processing it
in order. That is the property these rules exist to deliver, and it is the thing to test.

Closed without waiting on ticket 004. The decision is about processing semantics rather than
layering; where the re-fetch call physically sits remains an open item on 004, which has been noted
there.
