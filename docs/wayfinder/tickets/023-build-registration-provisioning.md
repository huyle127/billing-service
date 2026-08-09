# 023 Build registration provisioning and the Stripe sync reconciler

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-06) -->
<!-- assignee: -->
<!-- output: src/billing/, src/auth/ -->
<!-- blocked-by: 019, 020, 022 -->
<!-- change: build-registration-provisioning -->

## Question

How a new user gets entitlement instantly and a Stripe object shortly afterwards. Designed in
[`stripe-sync.md`](../../architecture/stripe-sync.md); this builds it.

The governing rule: **our database is authoritative for entitlement, Stripe for money.** A user who
registers during a Stripe outage gets Free access and credits immediately; only their ability to
*pay* is deferred.

- **Extend the registration transaction from 020.** One transaction creates `User`,
  `AuthCredential`, `BillingCustomer` with `stripeCustomerId = NULL`, the Free `Subscription` with
  `stripeSubscriptionId = NULL`, the `CreditWallet`, and the Free plan's monthly credits already
  allocated under this month's allocation key. **No Stripe call inside the transaction.**
- `BillingCustomer` is created **eagerly with a null id**, not once Stripe answers. If the row only
  appeared on success, a failed provisioning would leave nothing behind to find, and detecting
  affected users would require scanning `User` — reintroducing the full-scan problem the partial
  indexes exist to solve.
- **Provisioning is one idempotent routine reached from three triggers:** called at the end of
  registration without blocking the response; swept by the periodic reconciler; called defensively
  before any operation that requires a Stripe Customer (ticket 031's upgrade and 032's add-on
  purchase).
- The reconciler reads the partial index already in `prisma/sql/constraints.sql`:
  `stripeSubscriptionId IS NULL AND status IN (…)` ordered by `syncNextAttemptAt`, `LIMIT 50
  FOR UPDATE SKIP LOCKED`. Its cost is proportional to the outstanding backlog, not to table size —
  the property a full scan lacks and the reason no job table is needed.
- `syncAttempts`, `syncNextAttemptAt` (exponential backoff) and `syncError` live inline on the row.
  **No outbox and no job table**: the work is fully derivable from domain state, so the thing that
  needs doing is the thing that records it, and the work cannot be lost.
- **Escalate by age, not by attempt count.** A row pending longer than about an hour is a genuine
  alert — either Stripe has been down that long or our request is malformed and will never succeed.
  Retrying forever in silence is the failure mode to avoid.
- Order is **create in Stripe, then persist locally**, since network calls are barred from
  transactions. Three layers make crossing that window twice harmless: the Stripe idempotency key,
  our metadata searched before create (because Stripe's keys expire in 24 hours), and the unique
  constraint on `stripeCustomerId` — two concurrent provisioners cannot both persist a result, and
  the loser's retry finds the work done.
- `POST /v1/internal/provisioning/run` behind the internal API key, yielding a service principal
  with no user identity.

**Note the near-miss ticket 014 caught:** the registration grant and the first zero-amount
`invoice.paid` describe the same subscription and the same month. The allocation key is what
discards the second. Do not add a guard for this in application logic — the key already covers it,
and a second mechanism would be a second thing to keep correct.

**Inherited from ticket 020 — the internal API key.** 020 deferred it rather than build a guard whose
only caller was a probe controller in a test. This ticket ships the first endpoint behind it, so it
also builds `InternalKeyGuard` (timing-safe comparison against `INTERNAL_API_KEY`, already in
configuration) and the service principal that carries **no user identifier of any kind** — make that
unrepresentable in the type rather than rejected at runtime.

## Answer

Shipped through OpenSpec change `build-registration-provisioning`. **All three Section 3 clauses
closed**, across 24 new tests; the suite stands at 152 across 23 files. No schema change and no
migration — both partial indexes, the three inline sync columns, the unique `stripeCustomerId` and
the unique `CreditWallet.userId` were already in place, exactly as the ticket predicted. Four
configuration keys were added: `PROVISIONING_SWEEP_INTERVAL_MS` (zero disables the schedule),
`PROVISIONING_BATCH_SIZE`, `PROVISIONING_RETRY_BACKOFF_MS` and `PROVISIONING_STALE_AFTER_MS`, the
last of which also caps the exponential backoff.

**The sweep is claim-then-work, in two transactions, not one.** `FOR UPDATE SKIP LOCKED` holds row
locks for the life of its transaction and provisioning calls Stripe, so provisioning inside the claim
would hold locks across network I/O — the thing the architecture forbids because a slow Stripe
response becomes a service-wide stall. So one short transaction selects the batch and pushes
`syncNextAttemptAt` forward by the backoff for each row's current attempt count, then commits; the
work happens with no transaction open. **The claim is a lease**: once it commits, a concurrent
sweep's `syncNextAttemptAt <= now()` predicate no longer matches those rows, so `SKIP LOCKED` covers
the overlap *during* the claim and the lease covers it afterwards. The backoff is therefore written
*before* the attempt rather than after it, which is the right way round — a sweep that dies
mid-flight leaves rows that retry on schedule rather than rows nothing ever picks up again.

**Two services, because there are two routines.** `grantOnRegistration(tx, user)` runs inside
somebody else's transaction and must not touch the network; `provision(userId)` runs outside every
transaction and does almost nothing but. One service with two methods would put a transaction-safe
and a transaction-forbidden operation behind one name. The schedule is a third file for the same
reason: *what the sweep does* and *when it runs* are not the same class.

**The internal endpoint and its guard moved to ticket 028**, under ticket 020's own rule — build an
operation when a caller exists. With the in-process scheduler shipping here,
`POST /v1/internal/provisioning/run` had no caller of its own, and 020 had already refused to assert
`InternalKeyGuard` against a probe controller living in a test. 028 already carries
`POST /v1/internal/allocations/run`, so the guard gets built once against two real callers instead of
once against none. The two Section 9 clauses moved with it; `INTERNAL_API_KEY` stays in configuration
untouched.

**Registration reaches `credit` only through `billing`, and it took a constant to keep it that way.**
The transaction needs `LEDGER_TRANSACTION`'s timeouts now that it locks a wallet, but importing that
into `auth` would draw the `auth ──▶ credit` edge the design spends a paragraph denying. `billing`
re-exports it as `REGISTRATION_TRANSACTION`, derived from the same value, so the budget is inherited
rather than reinvented and the graph stays as drawn.

**A `Date` bound into raw SQL is not safe.** `node-postgres` serialises a `Date` with the local UTC
offset, and Postgres's `timestamp` parser silently discards that offset — against a
`timestamp without time zone` column holding UTC, the claim predicate would have been skewed by the
process's time zone. The claim binds `now.toISOString()` with an explicit `::timestamp` cast instead.
Prisma's own typed queries are unaffected; this is a raw-SQL-only trap, and the next raw query with a
date parameter will hit it too.

**An HTTP test cannot assert the Stripe objects, and the first draft that tried it failed.**
Registration does not await provisioning, so the assertion races the response — in practice
provisioning won, and `stripeSubscriptionId` was already attached by the time the test read the row.
That is the honest boundary the design predicted: registration tests assert the committed rows,
`provisioning.service.spec.ts` calls `provision` directly.

**The unique constraint on `stripeCustomerId` is not what makes concurrent provisioning safe.** The
ticket says two racing provisioners cannot both persist and the loser's retry finds the work done.
For one user that never happens: both write the *same* `BillingCustomer` row, so there is no second
write for the database to reject. What actually holds the line is the adapter's idempotency key —
both `createCustomer` calls derive `customer:{userId}` and get one Stripe object back. No P2002
recovery path was built, because nothing can reach it. The constraint still earns its place as the
backstop for the case where two different Stripe customers somehow exist.

**Registration's blast radius grew, and two existing tests paid for it.** `credit-http.spec.ts`
created a wallet for a user it had just registered — now a unique-constraint violation, since
registration opens one. Both helpers there now work with the wallet registration created rather than
against it. Anything that registers a user from now on inherits a customer, a subscription, a wallet
and an allocation whether it wants them or not.

## Requirement clauses closed

Section 3:

- Registration grants plan and credits without contacting Stripe
- Stripe customer and subscription provisioned immediately after registration
- A subscription with no Stripe id is a valid intermediate state

Section 9 — **handed to ticket 028**, not closed here:

- Internal key yields a service principal with no user identity
- Internal endpoints reject "act on behalf of" semantics
