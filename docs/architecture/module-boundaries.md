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
    services/        entitlement, provisioning, and the schedules that drive them
    repositories/    Plan, BillingCustomer, Subscription
    stripe/          StripeService — the only place Stripe SDK types are visible
    webhook/         controller, WebhookEvent repository, queue worker, handlers
  credit/            wallet, two ledgers, credit transactions
```

## Directory layout

This section is binding. A layout not described here needs this document changed first, because the
cost of an inconsistent tree is paid by every later reader, not by whoever introduced it.

**This is not the NestJS convention, and nobody should cite it as one.** `nest g resource billing`
produces a *flat* module — `billing.controller.ts`, `billing.service.ts`, `billing.module.ts` at the
module root, with only `dto/` and `entities/` as subdirectories. The framework's own documentation
shows the same shape. Grouping by role is a choice this repository makes on top of the framework,
and the reason is size: by the time tickets 023–033 have landed, `billing/` holds roughly eight
controllers, eight services, eight repositories, fifteen DTOs and six handlers. Forty-five files at
one level is not navigable, and `nest g` output will need moving after generation. That is the trade
being accepted, deliberately.

**A feature module has exactly these directories**, and creates each one only when it has something
to put in it:

```
<module>/
  controllers/       HTTP surface. One controller per route group.
  services/          business logic. The only layer that opens transactions.
  repositories/      Prisma access, one per aggregate — only where it earns its place, see below.
  dto/               request and response shapes. The only place class-validator appears.
  guards/            route guards specific to this module.
  decorators/        parameter and metadata decorators specific to this module.
  listeners/         event-bus subscribers. Audit, notification, analytics only.
  <module>.constants.ts
  <module>.errors.ts   this module's DomainException subclasses, when it declares any.
  <module>.module.ts
```

`controllers/` and `services/` are not optional layers to be collapsed when a module is small. A
controller holding business logic is the failure this prevents, and it does not become acceptable
because there is only one route.

**A scheduler is a service under `services/`, not a role of its own.** There is no `schedulers/`
directory: `provisioning-scheduler.service.ts` sits beside `provisioning.service.ts` and registers
an interval that calls it. It is a separate *file* rather than an `OnModuleInit` on the service it
drives, so that *what the sweep does* and *when it runs* are not the same class — the sweep is
reached identically by the schedule, by registration, and by any later caller. A directory would
file one file per module under a role that says nothing the `-scheduler` in the name does not.

**`repositories/` is conditional.** A module gets one when it has enough query surface for the
separation to buy something: several aggregates, queries built from varying criteria, or raw SQL
sitting next to Prisma calls. `billing/` and `credit/` qualify. A module whose repository methods
would each forward a single call to Prisma does not, and `auth/` and `user/` are that case — Prisma
Client is already a generated, type-safe data-access layer, and a class that adds nothing but a
second name for `findUnique` is a layer readers must traverse for no information.

What the seam actually rests on is **table ownership**, not the presence of a class: `AuthCredential`
is written only inside `src/auth/` whether or not a repository stands in front of it, and
`auth-seam.spec.ts` is what enforces it. Introduce the layer when the second non-trivial query
arrives, not in anticipation of it.

**An adapter directory groups by role too**, with the roles an adapter actually has. It has no
`controllers/` because it serves no routes and no `repositories/` because it owns no table, but the
contract, the implementations of that contract, and the types crossing it are three different things
and are separated as such:

```
billing/stripe/
  interfaces/
    stripe-adapter.interface.ts   the abstract class — contract and injection token in one
  adapters/
    stripe-sdk.adapter.ts         the implementation that talks to Stripe
    fake-stripe.adapter.ts        the implementation tests run against
  types/
    stripe.types.ts               domain types crossing the seam
  stripe.constants.ts             every provider-facing literal
  stripe.error.ts                 failure classification
  webhook-signature.ts            verification shared by both implementations
  stripe.module.ts
```

Three of these directories hold one or two files, and that is the cost of the rule rather than an
argument against it. What buys it back is that `interfaces/` and `adapters/` say out loud what a
`.service.ts` suffix said wrongly: the abstract class is not a service, and the two implementations
are not two services. A reader opening `adapters/` learns immediately that there is more than one
implementation, which is the single most important fact about this directory.

The three loose files stay loose because each is one thing with no sibling — a constants module, an
error classifier, a verifier shared by both adapters. A directory per file would be filing for its
own sake.

**A handler family gets its own directory once there is more than one member** —
`billing/webhook/handlers/`, one file per event type. A single `switch` over event types in one
service is what this replaces; it grows without bound and every arm shares a scope with every other.

**File naming is `<thing>.<role>.ts` in kebab-case**, and one exported class per file. The role
suffix must name the role the file actually plays: `subscription.controller.ts`,
`plan.repository.ts`, `stripe-sdk.adapter.ts`, `stripe-adapter.interface.ts`. `.service.ts` means a
service — not a contract, and not an infrastructure adapter. A suffix that lies is worse than none,
because it is believed.

**Three error suffixes exist and they are not interchangeable**, which is why they read as an
inconsistency at a glance and are not one:

| File | Holds |
| --- | --- |
| `<module>.errors.ts` | that module's `DomainException` subclasses, and nothing else |
| `<thing>.error.ts` | failure *classification* — logic that decides what a failure means, as `billing/stripe/stripe.error.ts` sorts Stripe failures into retryable and permanent |
| `common/errors/domain.exception.ts` | the `DomainException` base every module extends |

A module that only declares error classes uses the plural. Renaming a classifier to the plural would
tell readers it is a list of classes when it is a decision procedure.

**`.port.ts` is not used**, deliberately. Ticket 004 rejected hexagonal ports for a single provider,
and importing the vocabulary would reopen a closed decision by the back door.

**Tests sit next to what they test**, as `<file>.spec.ts`. A test that spans modules or needs the
HTTP layer lives in `test/` instead. Co-location is what keeps a unit test from being forgotten
when its subject moves.

**Injection tokens are abstract classes, never strings.** `{ provide: StripeService, useClass:
FakeStripeAdapter }` is checked by the compiler; `{ provide: 'STRIPE_SERVICE', ... }` is checked by
nobody, and it forces `@Inject()` at every call site.

## Names that must not be literals

A string that two files must agree on is a contract, and a contract that lives in two places will
eventually live in two versions. The failure is always silent: a search that finds nothing, an event
nobody handles, a config key that reads `undefined`.

| Kind of name | Where it lives | What stops a literal |
| --- | --- | --- |
| Environment keys | `common/config` — read through `AppConfigService` only | nothing outside `common/config` may touch `process.env` or `ConfigService` |
| Error codes | the `ErrorCode` union in `common/errors` | the union type |
| Domain enums — status, ledger, cycle, transaction type | Prisma-generated enums | the generated types |
| Stripe metadata keys, idempotency keys, API version, provider statuses | `billing/stripe/stripe.constants.ts` | a test asserting the seam builds none of them from a literal |
| Webhook event type strings | `billing/webhook/webhook.constants.ts`, beside the handler registry | `WebhookEventType` is a union derived from it |
| Adapter operation names | `STRIPE_OPERATIONS` in the same file | `StripeOperation` is a union derived from it |
| Event-bus event names | one constants file under the module that emits them | *to be added by the change that introduces the bus* |

Two rules follow from the table rather than being separate:

- **The key a writer writes and the key a reader queries must be the same expression**, not two
  literals that happen to match. `metadata.userId` written on create and `metadata['userId']` in a
  search query are the paired case that motivated this: a typo in either makes the adopt path find
  nothing, create a duplicate object, and report success.
- **Two implementations of one interface must derive shared values from one place.** The fake and
  the real adapter both compute `customer:{userId}`; if they computed it from separate literals, the
  test proving retries are safe would prove it only about the fake.

Literals used as test data — an email, a card brand, a fixed instant — are exempt. They are the
input to one assertion, not a contract between files.

## Dependency direction

```
auth ──▶ user
  │        ▲
  └──▶ billing
          │
          ▼
        credit
```

`credit` is a leaf. It never reads `billing`, `user`, or `auth`. This is the rule that keeps the
graph acyclic: credit allocation needs to know an *amount*, and the caller passes it. If credit ever
needs to look up a subscription to decide how much to allocate, the cycle is back — so it does not.

**`auth` sits at the top, and the `auth ──▶ billing` edge is what puts it there.** Registration opens
one transaction and creates `User` and `AuthCredential` in it; ticket 023 extends that same
transaction with `BillingCustomer`, the Free `Subscription`, and the `CreditWallet`. Pointing the
edge the other way — `billing` owning registration and calling `auth` — would make the largest module
depend on the one built to be deleted. With the edge this way round nothing imports `auth`, so when
an upstream Authentication Service arrives it is removed and provisioning is reached directly.

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

**How a module downstream of `auth` is authenticated without importing it.** A controller in `credit`
or `billing` needs the caller's identity, but importing `JwtAuthGuard` would give
`auth ──▶ billing ──▶ credit ──▶ auth`, a cycle this document forbids. Two rules keep the graph
acyclic:

- **The guard is registered once, as an `APP_GUARD` in `auth.module.ts`**, so every route in a module
  graph containing `auth` is authenticated by default and no controller applies it by hand.
  Registering it at the composition root instead was tried and rejected: a test harness that composes
  modules directly then runs weaker semantics than production, which is how a route silently loses
  its guard.
- **`common/identity/` publishes the shape of a verified identity** — `AuthenticatedUser`, the
  `RequestWithUser` type that names the request property, `@CurrentUser()`, and `@Public()` for the
  routes that opt out. Every module is downstream of `common`, so reading an identity adds no edge.
  `auth` keeps the guard that produces it, and an upstream Authentication Service arrives as a
  different guard filling the same property.

A route that must skip authentication says so with `@Public()`. Forgetting it breaks that route
loudly, where forgetting `@UseGuards` would have left one open silently.

**Role enforcement follows the same two rules.** `RolesGuard` is a second `APP_GUARD` in
`auth.module.ts`, and its marker `@Roles()` is published by `common/identity/` beside `@Public()`.
So a leaf module owns an admin route without an edge back to `auth`:
`POST /v1/admin/users/:userId/credits/adjust` lives in `credit`, marks itself `@Roles(Role.ADMIN)`,
and `credit-seam.spec.ts` still passes. Putting the route in an admin module outside `credit` was
rejected — it separates a controller from the only service it calls.

The guard returns `true` when a route marks no role, so registering it globally closes nothing that
was previously open. An unmarked route stays reachable by any authenticated caller.

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
