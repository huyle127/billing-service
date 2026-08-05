## Context

`src/billing/` does not exist yet. This change creates it, starting at its lowest layer: the adapter
that everything else in the module will call. It is worth a design note because the interface is a
contract between five later changes, because "which types cross the seam" is the decision that
determines whether a Stripe API version bump is a one-file edit or a service-wide one, and because
the fake is a second implementation that has to be designed rather than improvised.

Decisions already closed elsewhere are not reopened here:

- the seam itself and the module shape — [004 Design module boundaries and layering](../../../docs/wayfinder/tickets/004-design-module-boundaries.md)
- why `stripe-mock` and `stripe trigger` are not the fake — [003 Research Stripe object model and webhook semantics](../../../docs/wayfinder/tickets/003-research-stripe-object-model.md)
  and [010 Decide the testing strategy](../../../docs/wayfinder/tickets/010-decide-testing-strategy.md)
- the three-layer duplicate defence — [009 Design the auth module](../../../docs/wayfinder/tickets/009-design-auth-module.md),
  whose output includes [`stripe-sync.md`](../../../docs/architecture/stripe-sync.md) §3
- the account's `billing_mode` is `flexible`, and the value is an **object**, not a string —
  [034 Determine the Stripe account's billing mode](../../../docs/wayfinder/tickets/034-determine-stripe-billing-mode.md)

## Goals / Non-Goals

**Goals:**

- One interface, two implementations, chosen by injection. Calling code cannot tell which it holds.
- Make the two silent failure modes impossible: an inherited API version, and a duplicate object
  created because a retry crossed the idempotency window.
- Give retrying callers — the webhook worker, the sync reconciler — a verdict they can branch on
  without importing the SDK.

**Non-Goals:**

- **No retry loop, no backoff, no circuit breaker inside the adapter.** It classifies and rethrows.
  Retry policy belongs to the caller that owns the work item and its attempt counter.
- No provisioning logic. "Search by metadata, then create, then persist" is a flow, and flows live in
  services. The adapter supplies the search and the create.
- No caching. A retrieve is a call.
- No schema change, no configuration key, no controller, no route.

## Decisions

**The interface is an abstract class used as its own injection token, not a `Symbol` plus an
`interface`.** Nest resolves providers by runtime token; a TypeScript interface has none, so the
`Symbol` form forces `@Inject(STRIPE_SERVICE)` at every call site and loses the compiler's guarantee
that the fake satisfies the real shape. An abstract class is both the token and the type, and
`{ provide: StripeService, useClass: FakeStripeAdapter }` is checked at compile time. This is the
one place the seam's substitutability is enforced by anything other than discipline.

**Domain types are narrow projections, not mapped copies of the Stripe object.** The adapter returns
only fields a caller has a stated use for: ids, status, current period end, price and product ids,
`billingMode` as a plain string lifted from `billing_mode.type`, invoice status and amounts, and the
metadata we wrote. A full mapping would be a second Stripe schema to maintain, and every field it
carried would be a field a caller could come to depend on. Rejected alternative: returning the SDK
object behind a `type StripeCustomer = Stripe.Customer` alias — that is the seam in name only, and a
version bump would then reach every caller.

The `billing_mode` lift is the concrete case: ticket 034 found that
`subscription.billing_mode === 'flexible'` type-checks, compiles, and is always false, because the
value is an object. Reading `.type` once inside the adapter is the only place that mistake can be
made.

**Period end is read from the subscription item, and exposed as one value.** Since
`2025-03-31.basil` it lives on the item rather than the subscription. Callers get
`currentPeriodEnd` as a `Date` and never learn where it was read from — which is the whole argument
for the seam, made concrete.

**Idempotency keys are computed by the adapter from arguments it already receives.** A caller passes
`userId` to create a Customer; the adapter derives `customer:{userId}`. Letting callers pass a key
would make an inconsistent one possible between the fast path and the reconciler — the exact two
call sites that must agree. The catalog write derives from the plan `code`, which is stable and
unique per plan.

**The metadata search is the long-outage path, not a same-request deduplicator.** Stripe's Search
API is index-backed and lags writes by up to a minute, so an object created seconds ago may not be
findable. That is fine for the role it plays here — the idempotency key covers the first 24 hours,
and the search covers retries after it expires — but it means the search must never be used as the
sole guard on a hot path. Recorded because the failure it invites is invisible in testing against
the fake, where the search is instantaneous.

**Error classification maps SDK error types, and defaults to permanent.**

| Stripe error | Verdict |
| --- | --- |
| `StripeConnectionError`, `StripeAPIError` (5xx) | retryable |
| `StripeRateLimitError` | retryable |
| `StripeInvalidRequestError` | permanent |
| `StripeAuthenticationError`, `StripePermissionError` | permanent |
| `StripeSignatureVerificationError` | permanent |
| `StripeCardError` | permanent |
| anything unrecognised | permanent |

Defaulting to permanent is deliberate. An unknown error retried is an unknown error retried up to
the budget and then dead-lettered anyway, with the attempts hiding the original; an unknown error
failed fast surfaces at the first attempt with its request id intact. The domain error keeps the
Stripe error type name and `requestId`, because "which call failed" is unanswerable from our logs
alone once the request has left the process.

A card decline is permanent *as an API outcome* — retrying the same call with the same card changes
nothing. Dunning is a separate mechanism driven by Stripe's own retry schedule and its webhooks, and
is ticket 026's concern, not a retry inside this adapter.

**The fake stores objects in maps and generates ids from a counter.** It is a fake and not a mock:
tests assert on state it holds, not on calls it received. It carries the same idempotency key map the
real Stripe would, so "create twice with the same key returns the first object" is a property of the
fake too — otherwise the tests that matter most would pass against a fake that could not fail them.

**The fake signs payloads with the SDK's own test-header helper.** It lives inside
`src/billing/stripe/`, so SDK use there is within the seam, and it means a payload the fake signs is
verified by the same code path that verifies Stripe's. Rejected alternative: hand-rolling the HMAC in
the fake — that tests our HMAC against our HMAC and would pass while the real verification failed.

**Both implementations read time from the injected clock.** The signature timestamp and every
`currentPeriodEnd` the fake computes come from `common/clock`. The lint rule from change
`build-common-layer` bans `new Date()` here as everywhere, and this is the change where that rule
first has to hold outside `common/`.

**Add-on purchase is a PaymentIntent against the saved payment method, not an invoice item.** An
add-on is a one-off charge with no relationship to the subscription's billing period; attaching it to
the upcoming invoice would defer a purchase the user expects to complete now and would entangle
add-on credits with subscription proration. The adapter exposes `createOneTimePayment`; whether it is
confirmed off-session is the calling flow's decision in ticket 032.

## Risks / Trade-offs

- **The interface freezes early and five changes depend on it.** → Widening it later is cheap;
  changing what an existing operation means is not. The operation list comes from tickets 023, 024,
  029, 031, and 032 rather than from imagination, and anything not named by one of them is left out.
- **The fake will drift from Stripe's real behaviour.** → Unavoidable, and the reason the lifecycle
  test layer exists: `docs/testing/strategy.md` keeps a deliberately-run suite against a sandbox with
  test clocks. The fake's job is determinism for the invariants; the sandbox's job is truth about
  Stripe. Neither substitutes for the other.
- **Nothing in this change exercises the real adapter against Stripe.** Its tests run against the
  fake and against constructed errors, so a wrong parameter name in a real call would not be caught
  here — it would be caught by the first flow change that calls it. → Accepted: the alternative is a
  network-dependent test suite, which ticket 010 ruled out. The API version pin is the part that
  cannot wait, and that is asserted directly.
- **`metadata.userId` on every object is a small privacy surface.** → It is an opaque internal id,
  not an email, and it is the only thing that makes an orphaned object recoverable. Named so it is a
  choice rather than an accident.

## Migration Plan

None. No schema change and no configuration change, so nothing to migrate and nothing to roll back
beyond reverting the commit. Had a schema change been needed it would ship as
`prisma migrate diff --from-config-datasource --to-schema` followed by `prisma migrate deploy` —
never `db push`, and never `migrate dev` in a non-interactive shell.

## Open Questions

*Both resolved during implementation.*

- **Does `customers.search` cover every object the reconciler needs to find, or do subscriptions
  need `list` with a filter?** Search covers both. `stripe@22.4.0` exposes `search` on Customers,
  Subscriptions, Invoices, Prices, Products, PaymentIntents, and Charges, and the
  `metadata['key']:'value'` grammar is the same across them. No in-process filtering was needed and
  no list operation was added.
- **Which `stripe` SDK version string does `2026-07-29.dahlia` correspond to in the installed
  `stripe@^22.4.0` types?** It is exactly the SDK's `LatestApiVersion` — `cjs/apiVersion.d.ts`
  declares `ApiVersion = '2026-07-29.dahlia'`. The pin type-checks with no cast. Worth re-reading if
  the SDK is ever upgraded: the pin must then stay put while the types move, and that is the point
  at which a cast becomes necessary.

## Discovered during implementation

- **The `new Date()` lint rule from change `build-common-layer` over-fired.** Its selector was
  `NewExpression[callee.name='Date']`, which also banned `new Date(unixSeconds * 1000)` — a
  conversion that reads no clock and is unavoidable when mapping Stripe's epoch timestamps. The
  selector is now `[arguments.length=0]`, which is the rule's actual intent; `Date.now()` stays
  banned and the clock exemption is unchanged. A case was added to `clock-lint.spec.ts` so the
  narrowing is itself asserted.
- **`constructEvent`'s `receivedAt` parameter is milliseconds, not seconds.** The SDK divides it by
  1000 internally. Passing seconds made every signature timestamp look far in the future, so the
  300-second tolerance never rejected anything. Caught by the test that advances the injected clock
  past the tolerance — a test that only exists because the adapter passes our clock rather than
  letting the SDK read the system one.
- **`Invoice.subscription` no longer exists.** It is
  `invoice.parent.subscription_details.subscription`. This is the seam earning its keep on the first
  day: the restructure ticket 012 warned about is absorbed in one mapping function.
- **The pinned version cannot be applied to inbound webhook events from code.** An event's
  `api_version` is decided by the Stripe-side endpoint configuration. The adapter therefore verifies
  and exposes it, and logs a warning on mismatch rather than rejecting — rejecting would drop real
  traffic during a Stripe-side version change. The spec scenario was rewritten from "constructed
  under the pinned version" to the behaviour that is actually observable.
- **The first pass scattered provider-facing literals across three files.** Operation names appeared
  as string arguments in the adapter, again in the fake's fault injection, and a third time as a
  hand-kept array in the test. Idempotency prefixes and metadata keys were written twice — once in
  each implementation — which is exactly the shape that would let the fake pass the retry-safety
  test while the real adapter created duplicates. All of it now lives in `stripe.constants.ts`, with
  `StripeOperation` derived from the operation set so a misspelling fails to compile, and a test that
  fails if any seam file rebuilds a key from a literal. The binding layout and the no-literals rule
  went into `docs/architecture/module-boundaries.md`.
- **Nothing had asserted what the SDK adapter actually sends.** The idempotency and metadata tests
  all ran against the fake. Added a stubbed-client test that captures the real adapter's call options
  — the derived key and the declared metadata keys — without a network call.
- **The seam shipped flat and was then split by role.** The first pass put eleven files in
  `billing/stripe/` and defended it with a rule written the same day — *"an adapter directory is flat
  and has no layers"* — which exempted the only directory that existed. Checking `@nestjs/schematics`
  settled the framework question: `nest g resource` emits a flat module with only `dto/` and
  `entities/`, so grouping by role is this repository's choice about size, not a Nest convention, and
  the architecture document now says that in as many words. The seam is now `interfaces/`,
  `adapters/`, `types/` plus three single-purpose files, and the suffixes were corrected with it:
  `stripe-adapter.interface.ts` for the contract, `stripe-sdk.adapter.ts` and
  `fake-stripe.adapter.ts` for the implementations. `.port.ts` was rejected — ticket 004 closed
  hexagonal ports and the vocabulary would have reopened them sideways.
- **The fake carries two methods the interface does not.** `buildEventPayload` and `signPayloadWith`
  exist so webhook tests can produce verifiable bytes; they are test affordances on the fake, not
  operations of the seam, and calling code never sees them.
