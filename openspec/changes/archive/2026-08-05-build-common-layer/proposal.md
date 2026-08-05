## Why

Implements wayfinder ticket [018 Build the common layer](../../../docs/wayfinder/tickets/018-build-common-layer.md),
the root of the build frontier. Eight later changes each need an injectable clock, a typed
configuration surface, one error envelope, a metrics counter, and a raw request body. Without this
change they each invent their own, and three of those — the clock, the error codes, and the raw body
— are load-bearing rather than cosmetic: the annual allocation cron is untestable without an
injected clock, consumers branch on stable error codes, and Stripe signature verification fails
silently if the global JSON parser has already consumed the body.

## What Changes

- **Injectable clock** in `common/clock`, with a fixed implementation for tests, plus an ESLint rule
  banning `new Date()` outside that directory.
- **Typed configuration** in `common/config`: both database URLs, JWT secret and TTLs,
  `INTERNAL_API_KEY`, Stripe secret key, the **list** of webhook signing secrets, and retry backoff
  intervals. The service fails to boot on a missing or malformed value rather than at first use.
- **One error envelope** in `common/errors` — `{ error: { code, message, details } }` — with a base
  exception carrying a stable machine-readable `code`, a global exception filter, and the mapping
  from fault kind to HTTP status.
- **Global `ValidationPipe`** and the `/v1` global prefix.
- **Metrics counter seam** in `common/metrics`. No exposition endpoint in this change; the counter
  interface and an in-memory implementation only.
- **Raw body preservation** scoped to `POST /v1/webhooks/stripe` alone.

No schema change. No new runtime dependency beyond what `package.json` already carries.

## Capabilities

### New Capabilities

- `platform`: cross-cutting service infrastructure — time, configuration, the error contract,
  request validation, metrics, and the raw-body exception for webhook signature verification.

### Modified Capabilities

None. This is the first change against an empty spec set.

## Impact

- **New code**: `src/common/clock/`, `src/common/config/`, `src/common/errors/`,
  `src/common/metrics/`. `src/main.ts` and `src/app.module.ts` are modified to register the global
  prefix, pipe, filter, and the raw-body middleware.
- **Existing code**: `src/common/prisma/` is untouched.
- **Tooling**: one ESLint rule added. TypeScript stays pinned to 6 — TS 7.0 does not expose the
  programmatic compiler API the Nest CLI needs.
- **Downstream**: every subsequent change depends on this one. The error codes defined here become
  a public contract the moment `POST /v1/credits/consume` ships, because other applications branch
  on them.
- **Requirement coverage**: closes no clause in `docs/testing/requirement-coverage.md` directly.
  Its verification is the four assertions listed in the ticket — a test setting the clock and domain
  code observing it, the lint rule failing on a planted `new Date()`, a domain exception rendering
  the envelope with the right status, and the raw body arriving at a handler intact.
