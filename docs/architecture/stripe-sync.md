# Stripe Synchronisation and Failure Recovery

How the service stays correct when Stripe is slow, unavailable, or answers twice. Scoped to a small
or mid-sized SaaS on Prisma, PostgreSQL, and Stripe — deliberately not a distributed-systems
cathedral.

## The governing rule

**Each system is authoritative for different things.**

| | Authoritative for |
| --- | --- |
| Our database | Entitlement — which plan a user is on, what credits they hold |
| Stripe | Money — what was charged, what was paid, what is owed |

The service never blocks a user's entitlement on Stripe being reachable. A user who registers during
a Stripe outage gets Free access and credits immediately; only their ability to *pay* is deferred.

## 1. When creating the Stripe subscription fails

**Divergence is a named state, not an incident.** A current Subscription with
`stripeSubscriptionId = NULL` means "entitlement granted, Stripe object pending". The user has full
Free-tier access throughout. Nothing is broken and nothing needs paging.

Recovery is automatic: the row remains in the pending-sync index until provisioning succeeds. Each
failed attempt increments `syncAttempts`, records `syncError`, and pushes `syncNextAttemptAt`
forward with exponential backoff.

Escalation is by age, not by attempt count. A row pending for longer than a chosen threshold — an
hour is reasonable — is a genuine alert, because it means either Stripe has been down that long or
our request is malformed and will never succeed. Retrying forever in silence is the failure mode to
avoid.

**The dangerous direction is the opposite one:** the Stripe object was created but our database
write failed, leaving an orphan in Stripe that we have no record of. Section 3 is what prevents a
retry from creating a *second* orphan.

## 2. Event bus, outbox, queue, or reconciliation

**Chosen: state-derived reconciliation.** Rejected: all three alternatives, for specific reasons.

**Event bus** — rejected. An in-process emitter is not durable. A listener that throws loses the
work silently, with nothing left behind to indicate the work was ever owed. Architecture rule from
module boundaries: no invariant is ever maintained by an event listener.

**Redis queue (BullMQ)** — rejected. The stack is deliberately Neon-only. A second datastore would
also mean the job and the domain row can disagree.

**Outbox** — rejected *here*, but for a subtle reason worth stating, because outbox is the textbook
answer and dismissing it casually would be wrong.

An outbox is the right pattern when the work to be done **cannot be derived from domain state** —
"send a welcome email exactly once" leaves no trace in the domain model, so the intent must be
recorded explicitly. That is not our situation. "This subscription needs a Stripe object" is fully
visible in the subscription row itself.

Where the work *is* derivable, an outbox is strictly worse: it introduces a second source of truth
that can disagree with the first. If the outbox row is lost, nothing detects the missing work,
because the detector was the outbox. With state-derived reconciliation **the work cannot be lost**,
because the thing that needs doing is the thing that records it.

If a genuinely non-derivable side effect appears later — emails, analytics — add an outbox then, for
that. Do not add one now for work that does not need it.

**What reconciliation borrows from the outbox:** attempt tracking. Pure `IS NULL` gives no backoff
and no error visibility, so `syncAttempts`, `syncNextAttemptAt`, and `syncError` live inline on the
row. One store, one truth, with the retry metadata the job table would have carried.

**Three triggers, one idempotent routine:**

1. Called directly at the end of registration, not blocking the response. The fast path — normally
   completes within seconds.
2. Swept by a periodic reconciler. Catches everything the fast path lost.
3. Called defensively before any operation that requires a Stripe Customer — upgrade, add-on
   purchase. The last line of defence, on the one path where absence would actually hurt.

## 3. Retry and idempotency without duplicates

Three layers, because each covers a hole the others leave.

**Layer 1 — Stripe idempotency keys.** Every create call carries an `Idempotency-Key` derived
deterministically from our own identifiers:

```
customer:{userId}
subscription:{subscriptionId}
```

A retry within Stripe's retention window returns the original object rather than creating a second.
This covers the common case: timeout, immediate retry.

**Layer 2 — our identifiers in Stripe metadata.** Every object we create carries
`metadata.userId` and, for subscriptions, `metadata.subscriptionId`.

This matters because **Stripe's idempotency keys expire** (24 hours). A retry after a long outage
falls outside the window, and the key no longer protects us. Before creating, the provisioner
searches Stripe by metadata; if the object already exists, it adopts it instead of creating another.

Metadata is also what makes manual recovery possible. Without it, an orphaned Stripe object cannot
be traced back to a user except by guesswork.

**Layer 3 — the database constraint.** `stripeCustomerId` and the Stripe subscription reference are
unique where present. Two concurrent provisioners racing the same row cannot both persist a result;
the loser fails its write and retries, finding the work already done.

The ordering is deliberate: **create in Stripe, then persist locally.** Network calls are barred
from transactions, so there is always a window. Layers 1 and 2 exist precisely to make crossing that
window twice harmless.

## 4. Finding unsynced rows without scanning the table

A partial index. This is the whole answer.

```sql
CREATE INDEX "Subscription_pending_sync"
  ON "Subscription" ("syncNextAttemptAt")
  WHERE "stripeSubscriptionId" IS NULL
    AND status IN ('PENDING', 'ACTIVE', 'CANCELED', 'PAST_DUE');
```

The index contains **only rows still awaiting a Stripe object**. On a healthy system that is zero
rows or close to it, regardless of how many subscriptions exist in total. The reconciler's cost is
proportional to the outstanding backlog, not to table size — which is exactly the property a full
scan lacks and the reason this design scales without a job table.

The reconciler then reads:

```sql
SELECT * FROM "Subscription"
WHERE "stripeSubscriptionId" IS NULL
  AND status IN ('PENDING','ACTIVE','CANCELED','PAST_DUE')
  AND "syncNextAttemptAt" <= now()
ORDER BY "syncNextAttemptAt"
LIMIT 50
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE SKIP LOCKED` lets several workers run concurrently without processing the same row —
the same mechanism the webhook queue uses.

The equivalent index exists on `billing_customers`.

## 5. Schema

No `BillingJob` or `OutboxEvent` table. The sync state lives on the rows that need syncing.

```prisma
model BillingCustomer {
  stripeCustomerId  String?  @unique   // null = pending
  syncAttempts      Int      @default(0)
  syncNextAttemptAt DateTime @default(now())
  syncError         String?
}

model Subscription {
  stripeSubscriptionId String?          // null = pending
  stripePriceId        String?
  stripeStatus         String?          // raw Stripe value, reconciliation only
  syncAttempts         Int      @default(0)
  syncNextAttemptAt    DateTime @default(now())
  syncError            String?
}
```

`BillingCustomer` is created eagerly with a null `stripeCustomerId` rather than being created once
Stripe answers. If the row only appeared on success, a failed provisioning would leave nothing
behind to find, and detecting affected users would require scanning `users` — reintroducing exactly
the full-scan problem partial indexes solve.

The partial indexes are in `prisma/sql/constraints.sql`, since Prisma cannot express them.

**Identifier convention.** Table names match the Prisma model names exactly, so every identifier in
hand-written SQL must be double-quoted. Postgres folds unquoted identifiers to lower case, and an
unquoted `Subscription` resolves to a nonexistent `subscription` rather than failing loudly at the
point of the mistake.

## 6. How webhooks update the database

The pipeline is defined in [architecture.md](architecture.md). Two rules govern how handlers touch
domain rows.

**Webhooks never create domain rows. They attach and update.** Every Subscription originates from
our own flow, never from an inbound event. A `customer.subscription.created` handler matches on
`metadata.subscriptionId`, and:

- match found, no Stripe id recorded → attach: write `stripeSubscriptionId`, clear the sync state
- match found, already attached → no-op
- no match → **defer, do not create**

Deferring rather than creating is what stops duplicates when the webhook overtakes our own API call
— which it can, since Stripe may deliver `customer.subscription.created` before our
`subscriptions.create` response has been persisted. Creating a row on a missed match would produce
two subscriptions for one user and violate the one-current-subscription constraint.

**Handlers re-fetch and apply current state**, never trusting the payload's implied ordering, and
advance period-derived state monotonically so a late stale event cannot regress a subscription.

Within a handler the transaction covers the domain writes only. The re-fetch happens before it
opens.

### Interaction with provisioning

Both the reconciler and the webhook handler can attach the same subscription concurrently. This is
safe: both write the same value, the unique constraint admits one, and the loser's retry finds the
work already done. Attachment is idempotent by construction.
