# 024 Build webhook ingestion and the queue worker

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/webhook/ -->
<!-- blocked-by: 018, 019 -->

## Question

The pipeline, not the handlers. Build the machinery that receives, persists, and retries; the domain
handlers are tickets 026, 027, and 031.

- `POST /v1/webhooks/stripe`. **Signature verified against the raw body** preserved by 018, against
  a **list** of signing secrets — the secret printed by `stripe listen` differs from the Dashboard's,
  and rotation must not require a redeploy. This is the one route that bypasses the auth guards
  entirely.
- **Persist the `WebhookEvent`, then return 2xx.** Processing is asynchronous. A duplicate delivery
  hits the `stripeEventId` unique constraint and still returns 2xx — ingestion idempotency is the
  constraint, not a lookup.
- Worker: `SELECT … FOR UPDATE SKIP LOCKED` over `WebhookEvent` using the existing
  `@@index([status, nextAttemptAt])`, dispatch by `type` to a handler registry, then mark
  `COMPLETED`, schedule a retry, or `DEAD_LETTERED`. Same mechanism the sync reconciler uses, so
  several workers can run concurrently without colliding.
- **The registry dispatches to one file per event type in `billing/webhook/handlers/`**, not to arms
  of a `switch`. The binding layout is in
  [`module-boundaries.md`](../../architecture/module-boundaries.md); the reason it is named here is
  that tickets 026, 027, and 031 each add handlers to whatever shape this ticket leaves behind, and a
  switch is only ever grown, never split. **Event type strings are declared once** and referenced by
  both the registry and the handler that claims them.
- **Three outcomes, not two: completed, failed, and deferred.** A deferral — the event's subject does
  not exist locally yet — **must be distinguishable from a genuine failure and must not consume the
  retry budget the same way.** Ticket 017 required this because deferral is an ordinary race, not an
  error, and treating it as one would land normal traffic in the dead-letter queue. Ticket 026's
  handlers are the first to return it; define the outcome type here.

### The schema cannot express a deferral yet — settled 2026-08-05

Found while charting: `WebhookStatus` is `RECEIVED, PROCESSING, COMPLETED, FAILED, DEAD_LETTERED`
and there is a single `retryCount`. The rule above therefore has nowhere to live. **This ticket
carries a schema change:**

- Add **`DEFERRED`** to `WebhookStatus`, so a deferred event is visible as such in a status query
  rather than hiding inside `RECEIVED`.
- Add **`deferralCount`** alongside `retryCount`. Two counters, because they answer different
  questions and share no budget: `retryCount` is "how many times did processing genuinely fail",
  `deferralCount` is "how many times was this not yet applicable".
- **Deferrals still need a ceiling.** Ticket 017 said defer rather than fail; it did not say defer
  forever. An event whose subject never arrives — a Stripe object belonging to a user we never
  created — would otherwise cycle in the queue indefinitely. Give deferrals a budget far larger than
  the retry budget, and dead-letter on exhaustion with a failure reason that says the subject never
  appeared. Both budgets come from config so tests set them small.

**Migration traps.** Generate with `prisma migrate diff --from-config-datasource --to-schema` and
apply with `prisma migrate deploy` — `migrate dev` fails in a non-interactive shell when it emits a
warning, and `db push` is never an option. Separately: Postgres allows `ALTER TYPE … ADD VALUE`
inside a transaction, but **the new enum value cannot be used in the same transaction that adds it**.
Do not add `DEFERRED` and write a row using it in one migration.
- Backoff intervals come from config (018) so tests set them to zero and drive the worker directly.
  **The dead-letter path is asserted by exhausting the retry budget, never by sleeping.**
- Build one trivial handler to prove the pipeline end to end.

**Ticket 002's last open item lands here.** `stripe listen --forward-to` forwarding has never been
verified end to end, because until now no application existed to receive it. This is the ticket where
that check finally becomes possible — and `stripe trigger` is exactly the right tool for it, since
its only real use is smoke-testing that signature verification and the raw-body path work at all.

## Requirement clauses closed

Section 5:

- Signature verification against the raw body
- Endpoint returns 2xx once the event is persisted
- Ingestion is idempotent by Stripe event id
- Failed events retry with backoff
- Events exceeding the retry budget are dead-lettered

Section 10:

- Duplicate billing events handled safely
