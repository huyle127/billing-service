# Module Boundaries

## Modules

Four feature modules plus shared infrastructure. Each follows the same internal shape:
`controllers/ services/ repositories/`.

```
src/
  common/            guards, filters, interceptors, exceptions, logger, clock
  auth/              credentials, token issuance and verification
  user/              user identity
  billing/           subscriptions, payments, plans, Stripe
    stripe/          StripeService — the only place Stripe SDK types are visible
    webhook/         controller, WebhookEvent repository, queue worker, handlers
  credit/            wallet, two ledgers, credit transactions
```

## Dependency direction

```
auth ──▶ user
             ▲
billing ─────┘
   │
   ▼
credit
```

`credit` is a leaf. It never reads `billing`, `user`, or `auth`. This is the rule that keeps the
graph acyclic: credit allocation needs to know an *amount*, and the caller passes it. If credit ever
needs to look up a subscription to decide how much to allocate, the cycle is back — so it does not.

No module may import from a module that does not appear downstream of it here.

## Table ownership

A module never writes to a table it does not own. Reads across modules go through the owning
module's service, not through another module's repository.

| Module | Tables |
| --- | --- |
| `auth` | `AuthCredential` |
| `user` | `User` |
| `billing` | `Subscription`, `SubscriptionEvent`, `PaymentTransaction`, `PaymentMethod`, `Plan`, `AddonPackage`, `BillingCustomer`, `WebhookEvent` |
| `credit` | `CreditWallet`, `CreditTransaction` |

## Cross-module communication

**Direct service calls for anything that must be atomic.** The service owning the flow opens a
transaction and passes the transaction client into every participant, including services in other
modules. Subscription activation, credit allocation, and the payment record land in one transaction
or none of them do.

**The event bus only for work that is genuinely not part of the transaction** — audit trails,
notifications, analytics. An event handler must never be the thing that maintains an invariant.

This deliberately rejects the "modules communicate exclusively through an event bus" pattern. An
in-process event emitter does not join the caller's transaction, so an invariant maintained by a
listener can fail independently and leave the system in a state the requirements forbid — a
subscription marked active with no credits allocated. Requirements §5 demands webhook processing be
atomic at the Subscription aggregate level, and that is only achievable with a shared transaction.

## Seams

**The auth seam.** `auth` owns credentials only — email, password hash, refresh tokens. It is
expected to be removed when an upstream Authentication Service arrives. Nothing outside `auth` reads
`AuthCredential`. Billing and credit depend on a verified identity and role supplied by a guard,
never on the auth module's storage.

`user` is separate precisely so this removal is possible: `User` is what billing holds foreign keys
against, and it survives the auth module's deletion, becoming a projection synced from upstream.

**The Stripe seam.** `billing/stripe/` is the only place Stripe SDK types appear. Everything above it
sees domain types. This is a real seam with a second adapter — the test fake — not a hypothetical
one.

**The clock seam.** `common/clock` provides the current time by injection. Domain code never calls
`new Date()` directly; a lint rule enforces it. Without this the annual allocation cron, catch-up
across missed months, and stop-at-period-end are untestable, because a Stripe test clock moves
Stripe's clock and not ours.

**Not a seam: webhook ingestion.** The pipeline lives in `billing/webhook/` rather than a
general-purpose module. There is exactly one webhook source, so a generic abstraction would be a
seam for a variant that does not exist. If a second source ever appears, the queue machinery can be
lifted out then.
