# Architecture

A modular monolith on NestJS, TypeScript, Prisma, and Neon PostgreSQL. Module decomposition and
dependency rules are in [module-boundaries.md](module-boundaries.md); failure recovery and
Stripe/database convergence are in [stripe-sync.md](stripe-sync.md). This document covers layering,
transactions, and the machinery that spans modules.

## Layering

Three layers inside every module, with no additional application or domain-service layer.

| Layer | Responsibility |
| --- | --- |
| `controllers/` | HTTP shape only: routing, DTO validation, guards, response mapping. No business logic. |
| `services/` | Business rules, invariants, and orchestration. Owns transactions. |
| `repositories/` | Data access through Prisma. No business decisions. |

There is deliberately no separate use-case or application layer. At four modules the orchestration
each flow needs fits in the service of the module that owns the flow, and an extra layer would add
indirection without adding leverage. Clean and hexagonal architecture were considered and rejected
for the same reason: Prisma is the only data source, Stripe the only external integration, and the
ports-and-adapters ceremony would not pay for itself here.

## Transactions

`AGENTS.md` requires transactions for state-changing operations, and requirements §5 requires
webhook processing to be atomic at the Subscription aggregate level.

**The service that owns the flow opens the transaction.** Repositories and any cross-module service
accept the transaction client as a parameter, so a caller can compose several of them into one
transaction.

```
subscriptionService.handleInvoicePaid()
  └─ prisma.$transaction(tx =>
       subscriptionRepository.activate(tx, …)
       creditService.allocate(tx, …)          ← different module, same transaction
       paymentRepository.record(tx, …)
       subscriptionEventRepository.append(tx, …)
     )
```

Controllers never open transactions. Repositories never open transactions.

**No network calls inside a transaction.** Anything that talks to Stripe happens before the
transaction opens. Holding row locks across network I/O is what turns a slow Stripe response into a
service-wide stall.

Neon runs behind PgBouncer, so `DATABASE_URL` carries `pgbouncer=true` and migrations use
`DIRECT_URL`. Whether interactive transactions and row locking behave correctly on this path is
verified by ticket 006 before the ledger is built on it.

## Webhook pipeline

Lives in `billing/webhook/`. Requirements §5 defines the behaviour; this is the shape.

```
POST /webhooks/stripe
  → verify signature against raw body
  → persist WebhookEvent (unique on Stripe event id)
  → return 2xx immediately
                                    ┌──────────────────────────┐
worker (polling)                    │ WebhookEvent             │
  → SELECT … FOR UPDATE SKIP LOCKED │ status, retryCount,      │
  → re-fetch object from Stripe     │ nextAttemptAt, payload   │
  → dispatch to handler             └──────────────────────────┘
  → handler opens transaction, calls billing + credit services
  → mark completed, or schedule retry, or dead-letter
```

Signature verification needs the raw request body, so the Stripe webhook route is excluded from the
global JSON body parser. This is a common silent failure in NestJS and is called out here because it
looks like a signature bug rather than a parsing bug.

The verifier accepts a **list** of signing secrets, because the secret printed by `stripe listen`
differs from the Dashboard's and rotation must not require a redeploy.

### Ordering independence

Stripe does not guarantee event ordering. The processor is built so that replaying the entire event
history converges on the same result as processing it in order.

- **Re-fetch on receipt.** The handler fetches the affected object from Stripe and applies current
  state. The payload is a notification that something changed, not the authority on what it changed
  to. This happens before the transaction opens.
- **Monotonic guard.** Period-derived state only advances, never regresses, so a late stale event
  cannot roll a subscription backwards.
- **Defer, do not fail.** An event whose subject does not exist locally yet is answered non-2xx so
  Stripe redelivers it, and is recorded on the `WebhookEvent` row as a deferral rather than as a
  failure. Amended 2026-08-09 with requirements §5 — processing is synchronous, so there is no queue
  to return to and no retry budget of ours to exhaust; the distinction is kept for whoever reads the
  history.
- **Two layers of idempotency.** Ingestion is idempotent on Stripe event id. Credit allocation is
  additionally idempotent on invoice id plus billing period, enforced by a unique constraint,
  because two *distinct* events can describe the same paid invoice.

## Subscription state

The four lifecycle states are set by this service, not mirrored from Stripe. Stripe events are
inputs that trigger transitions; no business rule branches on a Stripe status value. `stripeStatus`
is stored verbatim for reconciliation and audit only. See the requirements document under
Subscription for the transition table.

## Cross-cutting

**Authentication.** Guards resolve a verified identity and role from a JWT. Three access paths
exist: user token, admin token, and an internal API key for service-to-service calls such as the
allocation cron. The Stripe webhook endpoint is the one route that bypasses JWT entirely — it
authenticates by signature instead.

**Time.** `common/clock` supplies the current time by injection. Domain code never calls `new Date()`
directly.

**Errors.** A single error shape across the service with machine-readable codes, so consumers can
branch on `INSUFFICIENT_CREDITS` versus `BILLING_FROZEN`. Both are business outcomes, not server
errors, and must not surface as 5xx.

**Events.** An in-process event bus carries audit, notification, and analytics work only. No
invariant is ever maintained by an event listener.
