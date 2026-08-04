# 011 Design the API surface and error model

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:grilling -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- output: docs/architecture/api-surface.md -->
<!-- blocked-by: -->

## Question

What endpoints does the service expose, and how does it report failure?

Blocked by 004 because module boundaries determine controller grouping, and by 008 because plan
management endpoints depend on where plans live.

Questions to resolve:

- **User endpoints** from requirements §9: view subscription, manage payment methods, view
  billing history, consume credits. Plus subscribing, upgrading, cancelling, and purchasing
  add-on packages. What is the full list?
- **Admin endpoints**: manage plans and packages, view user billing information, adjust add-on
  credits. Note requirements §4 restricts adjustments to Add-on Credits only — where is that
  enforced?
- **Internal endpoints**: the cron-triggered allocation path guarded by the internal API key.
- **The consume-credits endpoint** is the hot path other applications call. What is its contract,
  what does it return on success, and how does a caller distinguish `INSUFFICIENT_CREDITS` from
  `BILLING_FROZEN`? Both are business outcomes, not server errors.
- **Error model.** A single error shape across the service: machine-readable code, human message,
  and HTTP status mapping. Billing failures need stable codes consumers can branch on.
- **Validation.** DTO validation approach, and where it sits relative to the controller given
  `AGENTS.md` keeps business logic out of controllers.
- **Billing history** is a derived read-only view aggregated from three ledgers. Is it one
  endpoint with filtering, or several? How is it paginated?
- Does the API need versioning at this stage?

## Answer

Written to `docs/architecture/api-surface.md`.

**Consumption deducts before the caller works, not after.** Deducting afterwards lets ten concurrent
requests against a balance of five all complete before any balance check bites — the resources are
already spent by the time the ledger objects. The caller supplies an **idempotency key** on every
consumption, held under a unique constraint so a retry after a timeout charges once even under
concurrency.

**This exposed a gap in the requirements.** Deduct-first needs a way to give credits back when the
caller's work fails, and §4 restricts `adjustment` to admin-authorised changes on Add-on Credits —
so there was no legitimate way to return Subscription Credits. A **`REVERSAL`** transaction type was
added, linked to the original consumption and unique so a consumption can be reversed at most once.
Reservations (reserve → commit/release) were offered and not taken; they suit work whose cost is
unknown upfront, and they exceed what the requirements describe.

**Business outcomes return 200 with a result object.** Recommended against — 4xx carries semantics
that gateways, logs, and dashboards already understand — and not taken. The consequence is therefore
now a requirement rather than a caveat: **the service emits a decline counter labelled by reason**,
because with a 200 status nothing downstream can infer a decline. A user refused a thousand times
would otherwise be indistinguishable from a thousand successes.

The boundary is drawn explicitly so "always 200" does not swallow real faults: business outcomes get
200; malformed requests, authentication, authorization, and missing resources keep their status
codes; server faults stay 5xx. Faults use one envelope with a stable `code`.

**Decided without asking, being conventional:** `/v1` prefix from the start, since the consumption
endpoint has external callers and an unversioned contract change would break them silently.
Declarative DTO validation via a global pipe, with controllers doing no manual checking. Billing
history as one filtered endpoint rather than several, since the requirements define it as a single
derived view — and **cursor pagination rather than offset**, because history grows at the head and
offset paging would skip or duplicate rows.

**Placement note:** the admin adjustment restriction to add-on credits is enforced in the service,
not the controller. It is a domain rule; enforcing it at the controller would leave it unenforced
for every other caller.
