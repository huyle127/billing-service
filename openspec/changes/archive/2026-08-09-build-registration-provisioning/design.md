## Context

`src/billing/` currently holds only `stripe/` — the adapter seam ticket 019 built. `src/auth/`
registers a user and a credential in one transaction and stops there, with the transaction
deliberately left open at the point this change extends it. `src/credit/` holds every ledger
primitive ticket 022 built and no caller for the ones that put credits in.

This change is the first to exercise `auth ──▶ billing ──▶ credit` end to end, and the first to give
`billing` services and repositories of its own.

Decisions this change inherits and does not revisit: Free is a real Stripe subscription at a
zero-amount price and every user gets a Stripe Customer
([ticket 014](../../../docs/wayfinder/tickets/014-decide-free-plan-modelling.md), confirmed
empirically by [015](../../../docs/wayfinder/tickets/015-prototype-zero-price-invoice-paid.md)); the
opaque allocation key identifying subscription and month
([016](../../../docs/wayfinder/tickets/016-decide-credit-allocation-trigger.md), amended by 014); the
dependency direction and table ownership
([004](../../../docs/wayfinder/tickets/004-design-module-boundaries.md)); state-derived
reconciliation over an outbox or a queue, and the three idempotency layers
([017](../../../docs/wayfinder/tickets/017-design-out-of-order-webhook-handling.md), recorded in
[`stripe-sync.md`](../../../docs/architecture/stripe-sync.md)); adapter-derived Stripe idempotency
keys ([019](../../../docs/wayfinder/tickets/019-build-stripe-adapter.md)); and the schema with its
partial indexes ([007](../../../docs/wayfinder/tickets/007-design-persistence-schema.md)).

## Goals / Non-Goals

**Goals:**

- A registered user who can immediately see a plan and spend credits, whether or not Stripe answered.
- One idempotent provisioning routine that converges without supervision and cannot create a second
  Stripe object for the same user.
- A backlog sweep whose cost tracks the backlog, not the table.
- `billing` as a module with the layout the rest of the build will grow into.

**Non-Goals:**

- `POST /v1/internal/provisioning/run` and `InternalKeyGuard`. Deferred to ticket 028 — see below.
- Webhook attachment of `stripeSubscriptionId`. Ticket 026 adds the handler; this change only has to
  leave attachment idempotent so the two cannot collide.
- Upgrading, cancelling, or anything that reads `paidThroughAt`. Tickets 025, 027 and 031.
- The defensive third trigger's *callers*. The routine is public and idempotent; tickets 031 and 032
  call it.
- Any schema change. See below.

## Decisions

### One transaction, opened by `auth`, joined by `billing`, joined by `credit`

`AuthService.register` keeps ownership of the transaction and gains one call:

```
auth.register()
  └─ prisma.$transaction(tx =>
       user.createInTransaction(tx, …)
       tx.authCredential.create(…)
       billing.grantOnRegistration(tx, user)     ← different module, same transaction
         └─ billingCustomer.create(tx, …)        stripeCustomerId: null
         └─ subscription.createFree(tx, …)       stripeSubscriptionId: null, status ACTIVE
         └─ credit.createWallet(tx, userId)      ← different module again
         └─ credit.allocate(tx, userId, …)       additive, this month's key
     )
  → provisioning.provision(user.id)              after commit, not awaited
```

`credit` is reached through `billing`, never from `auth`: the dependency graph has no `auth ──▶
credit` edge, and `CreditWallet` is a `credit`-owned table so `billing` cannot write it either. Both
constraints point at the same shape, which is why `credit` gains `createWallet(tx, …)` rather than
`billing` inserting the row.

The transaction carries `LEDGER_TRANSACTION`'s timeouts, already used by every path that locks a
wallet. Registration now locks one, so it inherits the same budget rather than inventing a second
number.

*Alternative rejected:* `billing` owning registration and calling `auth`. Ticket 004 settled it — it
would make the largest module depend on the one built to be deleted.

### Two services, because there are two routines

`grantOnRegistration(tx, user)` and `provision(userId)` do genuinely different things: one runs
inside somebody else's transaction and must not touch the network, the other runs outside every
transaction and does almost nothing but. Naming them as one service with two methods would put a
transaction-safe and a transaction-forbidden operation behind one name.

```
billing/
  services/
    entitlement.service.ts            grantOnRegistration(tx, user)
    provisioning.service.ts           provision(userId), sweep()
    provisioning-scheduler.service.ts registers the interval, calls sweep()
  repositories/
    billing-customer.repository.ts
    subscription.repository.ts
    plan.repository.ts
  billing.constants.ts
  billing.module.ts
```

The scheduler is a third file rather than an `OnModuleInit` on `ProvisioningService`, so that *what
the sweep does* and *when it runs* are not the same class. Ticket 028 adds a sibling for allocation.

`plan.repository.ts` exists with one method because services never talk to Prisma directly. `billing`
qualifies for a repository layer under the rule in module-boundaries — it has several aggregates and
raw SQL sitting beside Prisma calls — and the rule applies to the module, not per file.

### The claim is what makes the sweep safe, not the lock

`FOR UPDATE SKIP LOCKED` holds row locks for the life of a transaction, and provisioning calls
Stripe. Holding locks across network I/O is exactly what the architecture forbids. So the sweep is
two phases:

1. **Claim** — one short transaction: `SELECT … FOR UPDATE SKIP LOCKED` over the pending predicate,
   then push `syncNextAttemptAt` forward on the selected rows by the backoff for their current
   attempt count. Commit.
2. **Work** — provision each claimed row with no transaction open, then record success or failure on
   the row.

The claim is a lease. Once committed, a concurrent sweep's `syncNextAttemptAt <= now()` predicate no
longer matches those rows, so the two sweeps stay disjoint after the locks are gone. `SKIP LOCKED`
handles the overlap *during* the claim; the lease handles it afterwards.

This also means the backoff is written before the attempt rather than after it. A sweep that crashes
mid-flight therefore leaves rows that retry on schedule rather than rows nothing ever picks up again —
the failure mode worth designing for, since a lost row is invisible.

*Alternative rejected:* provisioning inside the claim transaction. It is the shorter code and it
violates the no-network-in-transaction rule, which exists because a slow Stripe response would
otherwise become a service-wide stall.

### Adopt before create, on both objects

`provision(userId)` is customer-then-subscription, each step the same shape:

```
retrieve what we already recorded → if present, done
search Stripe by our metadata     → if found, adopt it and persist
create in Stripe                  → persist
```

The adapter derives the Stripe idempotency key itself (`customer:{userId}`,
`subscription:{subscriptionId}`), so the fast path and the sweep cannot disagree about it, and
`findCustomerByUserId` / `findSubscriptionByLocalId` are the metadata searches ticket 019 already
built for this. The search exists because Stripe's keys expire after 24 hours: a retry after a long
outage falls outside the window and the key protects nothing.

The customer must exist before the subscription, so a subscription cannot be created for a user whose
customer write failed.

### Only the subscription backlog is swept

`BillingCustomer_pending_sync` exists and is not swept. A Stripe Subscription cannot be created
without the Customer that owns it, so a `BillingCustomer` still pending always has a `Subscription`
still pending, and `provision` reaches the customer through it. Sweeping both would double the work
to reach the same rows.

The customer index is not dead: it is what a future operational query — "who is stuck without a
Stripe customer" — reads without scanning `BillingCustomer`. If a path ever appears that can attach a
subscription while leaving the customer pending, a second sweep is the change to make then.

### The allocation key is built in `billing`, and only there

`ALLOCATION_KEYS.month(subscriptionId, at)` lives in `billing.constants.ts` and yields
`sub:{subscriptionId}:{YYYY-MM}` from the injected clock in UTC. Registration passes it to
`credit.allocate` as an opaque string, exactly as ticket 022 requires — the ledger stores keys and
never interprets them, which is what keeps `credit` a leaf.

It is a shared constant rather than a literal for the reason the whole table in module-boundaries
exists: ticket 027's `invoice.paid` handler and ticket 028's cron must produce **the same string**
for the same subscription and month, or the near-miss ticket 014 caught reopens as a double grant.
That is also why no application-level guard is added for the registration/`invoice.paid` overlap:
the key already discards the second, and a second mechanism would be a second thing to keep correct.

### What the Free subscription row says at registration

| Field | Value | Why |
| --- | --- | --- |
| `status` | `ACTIVE` | Entitlement is granted now; `PENDING` means awaiting payment authentication, which a zero-amount plan never does |
| `cycle` | `MONTHLY` | The Free plan is monthly |
| `startedAt` | now, from the clock | |
| `stripeSubscriptionId`, `stripePriceId`, `stripeStatus` | null | Provisioning writes all three |
| `paidThroughAt` | null | Ticket 027 owns it, recorded from `invoice.period_end` |
| `nextCreditAt` | null | The annual cron's field; Free rides `invoice.paid` |

The Free plan is looked up by `code` and `cycle` — the internal identity requirements §3 fixes, never
the Stripe Price ID — and registration fails loudly if no active Free plan exists. That is a
misconfigured deployment, and a user provisioned with no plan would be a worse outcome discovered
later.

### Registration does not await provisioning

After the transaction commits, `register` calls `provision(user.id)` without awaiting it and swallows
the rejection. Swallowing is safe because the failure is not lost: `provision` has already written
`syncAttempts`, `syncError` and the next attempt time onto the row, and the sweep is what retries.

The cost is that an HTTP test cannot assert the Stripe object appeared — the assertion would race the
response. So the split is: registration tests assert the committed rows, and provisioning tests call
`provision` directly. That is the honest boundary, and pretending otherwise would produce a flaky
test that gets deleted later.

*Alternative rejected:* awaiting it and swallowing the error. It blocks every registration on a Stripe
round-trip to buy a test that could be written another way, and the ticket's requirement is explicit
that the response is not blocked.

### Escalation is a log line, and nothing more

Each sweep logs at error level every claimed row whose `createdAt` is older than
`PROVISIONING_STALE_AFTER_MS`, naming the subscription id, the attempt count and the recorded
`syncError`. No counter, no new metric constant, no alerting integration — the destination is a
locally running service, and a metric nothing scrapes is machinery that only looks like an alert.

Age rather than attempt count, because backoff makes the two diverge: a row failing every 30 seconds
and a row failing every 30 minutes reach ten attempts at very different ages, and it is elapsed time
that distinguishes "Stripe is having a bad minute" from "this request will never succeed".

### The schedule is registered at boot, from configuration

`@Interval(ms)` fixes its period at decoration time, before configuration is read. So
`ProvisioningSchedulerService` implements `OnModuleInit` and adds the interval through
`SchedulerRegistry`, skipping registration entirely when `PROVISIONING_SWEEP_INTERVAL_MS` is zero.
`ScheduleModule.forRoot()` is already registered in `app.module.ts`.

Zero-means-disabled is what keeps the test suite from sweeping underneath tests that assert on
pending rows, without a second code path for tests.

Four keys are added to `configuration.ts` following the shape `webhookConfig` already uses:

| Key | Default | Purpose |
| --- | --- | --- |
| `PROVISIONING_SWEEP_INTERVAL_MS` | `60000` | Sweep period; `0` disables |
| `PROVISIONING_BATCH_SIZE` | `50` | `LIMIT` on one claim |
| `PROVISIONING_RETRY_BACKOFF_MS` | `60000` | Base of the exponential backoff |
| `PROVISIONING_STALE_AFTER_MS` | `3600000` | Age past which a pending row is logged as an alert |

Backoff is `base × 2^attempts`, capped at the staleness threshold so a long outage cannot push a row
out to a retry interval measured in days.

### The internal endpoint and its guard move to ticket 028

The ticket placed `POST /v1/internal/provisioning/run` and `InternalKeyGuard` here. With the
in-process scheduler shipping in this change, the endpoint has no caller of its own, and ticket 020
already settled the rule that decides this — **build an operation when a caller exists** — which is
why 020 rejected asserting the guard against a probe controller living in a test.

Ticket 028 is titled *"Build the annual allocation cron and the internal endpoints"* and carries
`POST /v1/internal/allocations/run`, so building the guard there gives it two real callers instead of
none. `INTERNAL_API_KEY` stays in configuration untouched; the two Section 9 clauses move from
`todo — ticket 023` to `todo — ticket 028` with the reason recorded beneath the table, so the
deferral stays owned rather than becoming a clause nobody holds.

### No schema change, no migration

`BillingCustomer` and `Subscription` already carry `syncAttempts`, `syncNextAttemptAt` and
`syncError`; `stripeCustomerId` is already `@unique`; `CreditWallet.userId` is already `@unique`; and
`BillingCustomer_pending_sync`, `Subscription_pending_sync` and `Subscription_one_current_per_user`
are all applied by migration `20260804153434_add_ledger_constraints` and renamed by
`20260804163329_rename_tables_to_model_names`. Nothing here needs a column.

Should that turn out to be wrong during implementation, it ships as a migration generated with
`prisma migrate diff --from-config-datasource --to-schema` and applied with `prisma migrate deploy` —
never `db push`, because the hand-written constraints in `prisma/sql/constraints.sql` have nowhere to
live without a migration file.

The sweep's claim query is hand-written SQL, so every identifier in it is double-quoted. `"Subscription"`
unquoted resolves to a nonexistent `subscription` rather than failing at the point of the mistake.

### What is worth testing here

The rules that can break silently, and little else: the transaction commits and rolls back as a
whole, the registration grant lands under the month key that a second grant will collide with,
provisioning creates exactly one Stripe object across a retry after the idempotency window has
expired, two provisioners racing one user persist one customer, concurrent sweeps do not double-work
a row, and the pending predicate matches the partial index rather than the table.

Deliberately not tested per scenario: every field of the created rows, the exact backoff numbers, and
the log line's text. The fake adapter's `expireIdempotencyKeys()` and `failNext()` are what make the
first group assertable without a network.

## Risks / Trade-offs

- **Registration now writes six rows in one transaction, three of them through other modules** → a
  slower registration and a wider blast radius for a failure. Mitigated by the transaction being the
  point: a partial registration is the outcome worth preventing, and `LEDGER_TRANSACTION`'s existing
  timeouts bound it.
- **A leaked in-flight provisioning promise can settle after a test has truncated its tables** → an
  error logged from nowhere, or a confusing failure in an unrelated test. Mitigated by registration
  tests using the service directly rather than the HTTP route where they need determinism, and by the
  rejection being swallowed.
- **The claim writes the backoff before the attempt**, so a row that is claimed and then succeeds has
  had its `syncNextAttemptAt` moved for no reason → harmless, because success clears the sync state
  entirely. The reverse ordering would be the dangerous one.
- **The sweep interval defaults to 60 seconds and every instance runs its own** → several instances
  multiply the sweep rate. `SKIP LOCKED` plus the lease makes that safe rather than duplicative, and a
  single local instance is the destination.
- **Nothing sweeps `BillingCustomer_pending_sync`** → a customer stuck pending while its subscription
  is attached would never be retried. Argued unreachable above, and stated here so the assumption is
  recorded rather than assumed.
- **Stale rows are logged, not surfaced anywhere queryable** → an operator has to read logs to find
  the backlog. Accepted for a locally running service; ticket 028's internal endpoint is where a
  queryable answer would naturally live.
