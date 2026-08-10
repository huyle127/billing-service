## Context

`billing/stripe/` verifies signatures and maps objects; `WebhookEvent` exists with a unique
`stripeEventId`. Nothing reads either.

Requirements §5 specified an asynchronous queue, a worker and a retry budget until 2026-08-09, when
it was amended to synchronous processing because Stripe's own redelivery already provides the retry
the queue existed to give. This change is the first built against the amended text.

Inherited, not revisited: defer-don't-fail and the two idempotency layers
([017](../../../docs/wayfinder/tickets/017-design-out-of-order-webhook-handling.md)); one file per
event type and no-literals ([004](../../../docs/wayfinder/tickets/004-design-module-boundaries.md)).

## Goals / Non-Goals

**Goals:** an endpoint that records every event it was given whatever happens next; dispatch 026 and
027 can attach to unchanged; a history in which waiting and breaking do not look alike.

**Non-Goals:** the domain handlers (026, 027, 031); replaying a stored event (028); ordering
guarantees beyond deferral, which is 026's subject.

## Decisions

### The row is committed before processing, in a separate transaction

Persisting and processing cannot share a transaction. If they did, a handler failure would roll back
the event row as well, and the endpoint would answer non-2xx having stored no record of what it was
sent — losing exactly the audit history the table exists for.

So the row commits first with status `RECEIVED`, and processing runs afterwards in its own
transaction, updating the row to `COMPLETED` or `FAILED`. The subscription state changes a handler
makes stay atomic among themselves, which is what requirements §5 asks for.

### A duplicate is judged by status, not by existence

This is the trap the asynchronous design would have avoided for free, because a worker selects rows
by status and never sees the question.

Stripe redelivers a failed event, so redelivery is the normal path to success, not an anomaly. If the
endpoint treated any existing `stripeEventId` as already handled, every event whose first attempt
failed would be acknowledged and dropped forever — a silent loss, and the worst failure this design
can produce. So a `COMPLETED` redelivery is skipped and any other status is processed again. The
unique constraint still stops a second row appearing; what it no longer decides alone is whether the
work was done.

### Failure and deferral share a response and differ in the record

Both are answered non-2xx, because both want Stripe to send the event again, and Stripe offers one
way to ask. They differ in what the row keeps: a deferral records that the subject was missing, a
failure records what broke.

With retries owned by Stripe there is no budget of ours for the distinction to protect, so it is kept
for whoever reads the history — a deferral is an ordinary race expected to resolve, a failure is not.
The recorded reason carries the difference and `WebhookStatus` is left alone, which is why no
migration is needed.

### Dispatch is a registry keyed by event type

`handlers/` holds one file per event type; the registry maps type string to handler. An unknown type
completes without work — Stripe sends types nobody subscribed to, and failing those would bury the
real failures under noise and ask Stripe to redeliver them forever.

Type strings are declared once in `webhook.constants.ts` and referenced by both the registry and the
handler claiming them, under the no-literals rule.

### What is worth testing

Six, against the budget of 10. A forged signature is rejected and persists nothing; a redelivered
`COMPLETED` event is skipped and leaves one row; a redelivered `FAILED` event is processed again;
a handler failure answers non-2xx and records the reason; a deferral is recorded distinguishably from
a failure; dispatch reaches the handler claiming the type and an unknown type completes without work.

The third of those is the one that earns its place — it is the silent-loss path, and nothing else in
the suite would catch it. Not tested: log lines, the 2xx body, Stripe's redelivery timing.

## Risks / Trade-offs

- **A slow handler risks Stripe's request timeout** → handlers here are one short transaction;
  requirements §5 names this as the point at which asynchronous processing returns.
- **An event failing past Stripe's redelivery window is abandoned** → the row survives with its
  reason, which is what makes it findable; no queue would have made Stripe try longer.
- **`stripe listen` forwarding is verified by hand** → it needs a real CLI and network, so ticket
  002's last item closes on a manual check recorded in that ticket.
