## Why

Nothing receives Stripe events, so tickets 026, 027 and 031 are handlers with no endpoint to attach
to, and ticket 002's `stripe listen` forwarding has never been verified for want of one. This change
builds reception, storage and dispatch — leaving each domain handler to its own ticket. Implements
**024 Build webhook ingestion and the queue worker**
(`docs/wayfinder/tickets/024-build-webhook-ingestion-and-worker.md`).

## What Changes

- **`POST /v1/webhooks/stripe`** verifies the signature against ticket 018's raw body, against a
  *list* of secrets — `stripe listen` prints a different one from the Dashboard's and rotation must
  not need a redeploy. The one route bypassing the auth guards.
- **Persist, process, then answer.** The row commits before processing so a failure still leaves a
  record; processing runs in its own transaction and the response reports its outcome.
- **Processing is synchronous, and Stripe owns the retry.** A failed or deferred event is answered
  non-2xx and Stripe redelivers. Requirements §5 was amended for this on 2026-08-09; it previously
  specified a queue, a worker and a retry budget of ours.
- **Redelivery is decided by the stored status, not by the row's existence.** A repeat of a
  `COMPLETED` event is acknowledged and skipped; a repeat of a `FAILED` one is processed again.
  Treating any duplicate as done would silently drop every event whose first attempt failed.
- **Dispatch is a registry of one file per event type**, type strings declared once, an unsubscribed
  type completing without work. One trivial handler proves the path; 026 and 027 add the real ones.
- **No schema change and no migration.** `WebhookEvent`, its unique `stripeEventId` and the existing
  `WebhookStatus` values cover every state this design reaches.

## Capabilities

### New Capabilities

- `webhook-pipeline`: how an event is received, made idempotent, recorded, dispatched, and
  distinguished between failure and deferral — independent of what any handler does.

## Impact

**Clauses moved off `todo`**, verbatim — Section 5: `Signature verification against the raw body`,
`Endpoint returns 2xx once the event is persisted`, `Ingestion is idempotent by Stripe event id`;
Section 10: `Duplicate billing events handled safely`. **Re-pointed, not closed**: `Failed events
retry with backoff` and `Events exceeding the retry budget are dead-lettered` now describe Stripe's
redelivery rather than ours, and are rewritten in the coverage table to say so.

**Test budget — 6 new tests**, under the ceiling of 10. **Code**: `src/billing/webhook/`,
`src/common/config/`, `src/app.module.ts`. **Unblocks** 026, 027, and ticket 002's last item.
