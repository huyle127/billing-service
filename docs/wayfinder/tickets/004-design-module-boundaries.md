# 004 Design module boundaries and layering

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- output: docs/architecture/architecture.md, docs/architecture/module-boundaries.md -->
<!-- blocked-by: -->

## Question

What are the modules of this service, what does each own, and what may each depend on?

This is the keystone ticket — 007, 009, and 011 all block on it. It produces content for the two
empty stubs `docs/architecture/module-boundaries.md` and `docs/architecture/architecture.md`.

Questions to resolve:

- What are the modules? A first guess from the domain model: subscription, credit wallet /
  ledgers, payments, webhook ingestion, auth, admin, billing history. Is that the right cut, and
  does anything belong together that this splits apart?
- What is the layering inside a module, given `AGENTS.md` requires business logic out of
  controllers and Stripe as an infrastructure adapter? Where does the Stripe adapter interface
  live, and who is allowed to see the Stripe SDK types?
- **The auth seam.** The auth module is destined to be torn out and replaced by an upstream
  service. What is the interface billing code depends on so that removing the module touches
  nothing else?
- **The identity seam.** Requirements §3 says the upstream User Service owns core user identity
  while the Billing Service owns the Stripe billing identity mapping — but the in-repo auth
  module now also stores a local `User`. Where does the boundary sit between the auth module's
  user record, a billing-side user reference, and the Stripe customer mapping?
- Which module owns the webhook worker, and how does it dispatch into subscription, payment, and
  credit logic without creating a cycle?
- Where do the transaction boundaries sit? Requirements §5 demand webhook processing be atomic at
  the Subscription aggregate level — which layer opens the transaction?

- **The application clock seam** (surfaced by ticket 003). Stripe test clocks move *Stripe's*
  clock, not ours. Our annual-subscription cron, catch-up allocation, and period-boundary checks
  all read the current time, and none of it is testable unless time is injected rather than read
  from the system. Where does that abstraction live, and what stops code from calling `new Date()`
  directly? This is a cross-cutting seam, so it belongs in the boundary design.
- **Where the Stripe re-fetch sits.** Ticket 017 decided that every webhook handler re-fetches the
  affected object from Stripe rather than trusting the payload. That puts a Stripe adapter call
  inside webhook processing — decide which layer owns it, how it is stubbed in tests, and how the
  monotonic period guard is expressed without leaking Stripe types upward.

Consult `/codebase-design` and `/domain-modeling`.

## Answer

Written to `docs/architecture/module-boundaries.md` and `docs/architecture/architecture.md`, the
two stubs this effort existed to fill.
whose architecture decision report proposes a hybrid event-driven modular monolith over three
modules. Most of it was adopted; one central rule was rejected.

**Adopted:**

- **Four feature modules** — `auth`, `user`, `billing`, `credit` — each shaped
  `controllers/ services/ repositories/`. `credit` is a leaf and never reads the others, which is
  what keeps the graph acyclic: the caller passes the amount to allocate.
- **No use-case or application layer, and no clean/hexagonal ports.** The reference report rejects
  these as over-engineering for a module count this small, and that judgement applies here. The
  first proposal in this session included a use-case layer; it was dropped as ceremony that did not
  pay for itself.
- **Table ownership** is exclusive; a module never writes to a table it does not own.
- The reference report's invariants, particularly controllers holding no logic and credit mutations
  always being atomic with their transaction record.

**Rejected: "modules communicate exclusively through an event bus."** An in-process emitter does not
join the caller's transaction, so an invariant maintained by a listener can fail on its own and
leave a subscription active with no credits allocated — which requirements §5 forbids by demanding
atomicity at the Subscription aggregate level. Instead: direct service calls with a shared
transaction client for anything atomic, and the event bus only for audit, notification, and
analytics. No invariant is ever maintained by a listener.

**Seams decided:**

- **Auth** owns credentials only and is built to be deleted. `user` is separate so that `User` — what
  billing holds foreign keys against — survives that deletion as an upstream projection.
- **Stripe** is confined to `billing/stripe/`; it is a real seam because the test fake is a second
  adapter.
- **Clock** is injected from `common/clock`, with a lint rule banning direct `new Date()` in domain
  code. Ticket 010 established this is mandatory, not stylistic.
- **Webhook ingestion is not a seam.** It lives in `billing/webhook/` because there is exactly one
  webhook source; a generic module would abstract over a variant that does not exist.

**Transaction rule:** the service owning the flow opens the transaction; repositories and
cross-module services accept the transaction client as a parameter. Controllers and repositories
never open transactions. **No network calls inside a transaction** — the Stripe re-fetch required by
ticket 017 happens before the transaction opens, so row locks are never held across network I/O.
