# 019 Build the Stripe adapter seam and its test fake

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-05) -->
<!-- assignee: -->
<!-- output: src/billing/stripe/ -->
<!-- openspec-change: build-stripe-adapter -->
<!-- blocked-by: 018 -->

## Question

What interface does `billing/stripe/` expose, and what is the fake that every integration test runs
against?

Ticket 004 called this a real seam rather than a hypothetical one, precisely because the test fake
is a second adapter. Build both together or the interface will be shaped by only one caller.

- **`StripeService`** is the only place `stripe` SDK types are visible. Everything above it sees
  domain types.
- **Pin `apiVersion` explicitly** to `2026-07-29.dahlia`, on the client and on the webhook endpoint,
  rather than inheriting the account default. Silent version drift is not hypothetical here:
  `2025-03-31.basil` moved `current_period_end` off the Subscription object and restructured
  Invoice, and it would break the credit path without an error.
- Operations later tickets need: create and retrieve Customer; create, retrieve, update and cancel
  Subscription; create Product and Price; archive Price; attach and detach PaymentMethod; retrieve
  Invoice; create a one-time payment for add-ons; construct and verify webhook events against a
  **list** of signing secrets.
- **Idempotency keys derived from our own identifiers** — `customer:{userId}`,
  `subscription:{subscriptionId}`, the plan `code` for catalog writes. A retry inside Stripe's
  window returns the original object instead of creating a second.
- **Metadata tagging.** Every object we create carries `metadata.userId`, and subscriptions carry
  `metadata.subscriptionId`. This matters because **Stripe's idempotency keys expire after 24
  hours** — a retry after a long outage falls outside the window and the key no longer protects us.
  Search by metadata before creating, and adopt what is found. Metadata is also the only thing that
  makes an orphaned Stripe object traceable back to a user.
- **Error classification** — retryable (network, rate limit, 5xx) versus permanent (invalid
  request). Both the webhook worker and the sync reconciler branch on it; without it a malformed
  request retries until it exhausts its budget instead of failing fast.
- **The fake.** A second adapter behind the same interface, stateful enough to carry a subscription
  through its lifecycle. Ticket 003 eliminated the obvious alternatives: `stripe-mock` is stateless
  by design and Stripe has said it will stay so, and `stripe trigger` creates real objects and fires
  cascading events, so a test asserting on one event receives several. Webhook tests construct and
  sign their own payloads with the test signing secret — no network, deterministic, and able to
  produce sequences Stripe would rarely emit.

Account facts from ticket 002: `acct_1TlhMSFaNFL0w4nv`, test mode, the Free/Pro/add-on catalog
already exists, and **nine leftover products pollute the account** — seven named `myproduct`, two
named `Dahlia Verify Pro`. Nothing in this service may enumerate the catalog from Stripe.

Closes no requirement clause directly. Every Stripe-touching ticket depends on it.

## Answer

Built on 2026-08-05 through OpenSpec change `build-stripe-adapter`, archived under
`openspec/changes/archive/2026-08-05-build-stripe-adapter/`. `src/billing/stripe/` holds the
contract, the SDK adapter, the fake, the error classifier, and the shared webhook verifier; behaviour
is recorded in [`openspec/specs/stripe-adapter/spec.md`](../../../openspec/specs/stripe-adapter/spec.md),
the second capability spec in this repo. Build, lint, and **56 passing tests** (up from 25), 31 of
them new here. No schema change, no configuration key, no network call in the suite.

**The interface is an abstract class used as its own injection token.** A `Symbol` plus a TypeScript
`interface` would have forced `@Inject()` at every call site and lost the only compile-time proof
that the fake satisfies the real shape. `{ provide: StripeService, useClass: FakeStripeAdapter }` is
checked by the compiler, which is what makes this a seam rather than a convention.

**Sixteen operations, no listing operation.** Products and Prices are never enumerated from Stripe —
the account's nine leftover products would come back as objects this service cannot classify. A test
asserts no `list*` method exists on either adapter, and another asserts no file outside
`src/billing/stripe/` imports the `stripe` package.

**Idempotency keys are derived inside the adapter, never passed in.** `customer:{userId}`,
`subscription:{subscriptionId}`, `product:{code}`, `price:{code}:{amount}`,
`payment:{purchaseId}`. Callers cannot supply one, so the fast path and the reconciler cannot
disagree about it.

**The fake keeps its own idempotency map**, so "create twice under the same key returns the first
object" is a property the fake can actually fail. A fake that could not fail the tests that matter
most would be worse than no fake.

**The layout and the naming rule were made binding here**, after reading how
`nghiahoangDigiEx/AI-billing-service` splits its modules and after checking what NestJS itself
prescribes. Both now live in [`module-boundaries.md`](../../architecture/module-boundaries.md),
echoed into `openspec/config.yaml` so every future proposal reads them, with the handler rule also
named in ticket 024 where it will first be built.

**Grouping by role is not the NestJS convention, and the document now says so.** `nest g resource`
emits a *flat* module — controller, service and module file at the module root, with only `dto/` and
`entities/` as subdirectories — and the framework's docs show the same. The reference repo's own
design note is equally candid: it chose layer folders *"because the user explicitly preferred Option
2A"*, and recorded the cost, that files of one domain now sit in three directories. This repository
groups by role anyway, for a reason that is about size rather than convention: tickets 023–033 leave
`billing/` at roughly forty-five files, and forty-five at one level is not navigable. Naming that
honestly matters, because "it is the Nest convention" would have been believed and repeated.

**The seam was flat and is not any more.** The first pass put eleven files in `billing/stripe/` and
justified it with a rule — *"an adapter directory is flat and has no layers"* — written into the
architecture document in the same sitting. That rule exempted the only directory that existed, which
is not how a rule earns its place. The seam is now `interfaces/`, `adapters/`, `types/` plus three
single-purpose files. Three of those directories hold one or two files; that is the cost, paid to
get names that stop lying — the abstract class was called `stripe.service.ts` while being a
contract, and the two implementations carried `.service.ts` while being adapters. `.port.ts` was
rejected for the interface: ticket 004 closed hexagonal ports, and the vocabulary would reopen it
sideways.

Two things that repo does were **not** adopted: a separate `payment` module abstracting the provider
— ticket 004 already rejected that for a single provider — and services reaching Prisma directly
with no `repositories/`. One thing it does that we do not, its `@/` path alias, is now ticket 035.
Worth recording for whoever reads that repo next: its handler split is real, but the handlers are
re-attached by hand in `StripeModule.onModuleInit()` with `registerHandler('invoice.paid', …)`, so a
handler that is never registered fails silently — the magic string returns at the seam of the very
refactor that removed it.

The magic-string pass belongs to this ticket too. Operation names existed in three places, and the
idempotency prefixes and metadata keys in two — one per adapter. That last one is the dangerous
shape: the fake and the real adapter computing `customer:{userId}` from separate literals would let
the test proving retries are safe prove it about the fake alone. Everything provider-facing is now in
`stripe.constants.ts`, `StripeOperation` is derived from the operation set so a misspelling does not
compile, and a test fails if any seam file rebuilds a key from a literal.

### Problems hit, and their fixes

- **`constructEvent`'s `receivedAt` parameter is milliseconds, not seconds** — the SDK divides it by
  1000 internally. Passing seconds made every signature timestamp look far in the future, so the
  300-second tolerance never rejected anything. Caught by the test that advances the injected clock
  past the tolerance, which exists only because the adapter passes *our* clock instead of letting the
  SDK read the system one.
- **The `new Date()` lint rule from ticket 018 over-fired.** Its selector banned every
  `new Date(...)`, including `new Date(unixSeconds * 1000)` — a conversion that reads no clock and is
  unavoidable when mapping Stripe timestamps. Narrowed to `[arguments.length=0]`, which is the rule's
  actual intent. `Date.now()` stays banned; a new lint case asserts the narrowing.
- **`Invoice.subscription` no longer exists** — it is
  `invoice.parent.subscription_details.subscription`. The restructure ticket 012 warned about is now
  absorbed in one mapping function, which is the seam earning its keep on day one.

### Decisions revised on contact with the code

- **The pinned version cannot be applied to inbound webhook events from code.** An event's
  `api_version` is set by the Stripe-side endpoint configuration. The adapter verifies the signature,
  exposes the version on the domain event, and **logs a warning on mismatch rather than rejecting** —
  rejecting would drop real traffic during a Stripe-side version change. The spec scenario was
  rewritten from "constructed under the pinned version" to what is actually observable.

### Answers to the two questions the design left open

- **Metadata search covers subscriptions.** `stripe@22.4.0` exposes `search` on Customers,
  Subscriptions, Invoices, Prices, Products, PaymentIntents and Charges with the same
  `metadata['key']:'value'` grammar. No in-process filtering, no list operation.
- **`2026-07-29.dahlia` is exactly the SDK's `LatestApiVersion`**, so the pin type-checks with no
  cast. On the next SDK upgrade the pin must stay put while the types move, and that is when a cast
  becomes necessary.

### Notes for later

- **Nothing here has spoken to Stripe.** The suite runs against the fake and against constructed
  errors, so a wrong parameter name in a real call would surface only in the first flow that makes
  it — ticket 023. The version pin is the part that could not wait, and it is asserted directly.
- **The Search API lags writes by up to a minute.** The metadata search is the post-24-hour fallback,
  not a same-request deduplicator; the idempotency key covers the hot path. Against the fake the
  search is instantaneous, so this failure mode is invisible in testing. Tickets 023 and 032 must not
  lean on it as a sole guard.
