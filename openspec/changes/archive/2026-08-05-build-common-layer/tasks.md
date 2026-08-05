## 1. Configuration

- [x] 1.1 Create `src/common/config/` with a typed accessor covering both database URLs, JWT secret and token lifetimes, `INTERNAL_API_KEY`, Stripe secret key, the webhook signing secret **list**, and retry backoff intervals
- [x] 1.2 Validate every required value at boot so a missing or malformed one fails startup by name
- [x] 1.3 Register the config module globally in `app.module.ts`
- [x] 1.4 Add the new keys to `.env.example`, leaving `.env` alone
- [x] 1.5 Test: startup fails and names the value when a required key is absent; multiple signing secrets all reach the accessor

## 2. Clock

- [x] 2.1 Create `src/common/clock/` with the `Clock` interface, a system implementation, and a fixed implementation for tests
- [x] 2.2 Add the ESLint rule banning `new Date()` under `src/`, exempting `src/common/clock` and excluding `prisma/` and `test/`
- [x] 2.3 Test: a fixed clock installed by a testing module is what domain code observes
- [x] 2.4 Test: the lint run fails on a planted `new Date()` and names the file

## 3. Error model

- [x] 3.1 Create `src/common/errors/` with the error-code union, seeded only with the validation and not-found codes this change needs
- [x] 3.2 Add the base domain exception carrying a stable `code`, and the mapping from fault kind to HTTP status
- [x] 3.3 Add the global exception filter rendering `{ error: { code, message, details } }`
- [x] 3.4 Register the filter and a global `ValidationPipe` in `main.ts`
- [x] 3.5 Test: a thrown domain exception renders the envelope with the right status; a malformed body returns `400` in the same shape

## 4. Routing and raw body

- [x] 4.1 Set the `/v1` global prefix in `main.ts`
- [x] 4.2 Preserve the raw request body for `POST /v1/webhooks/stripe` only, leaving every other route on the parsed JSON body
- [x] 4.3 Test: a handler on the webhook path reads the exact bytes sent and a correctly signed payload verifies; another route still receives parsed JSON
- [x] 4.4 Test: a request without the `/v1` prefix does not reach a controller

## 5. Metrics

- [x] 5.1 Create `src/common/metrics/` with the counter interface and an in-memory implementation
- [x] 5.2 Test: a counter increments per label set, and distinct label sets count separately

## 6. Close out

- [x] 6.1 Run `npm run build`, `npm test`, and the lint run; all three pass
- [x] 6.2 Confirm `prisma/schema.prisma`, `prisma.config.ts`, and `src/common/prisma/` are unmodified by this change
- [x] 6.3 Update `docs/testing/requirement-coverage.md` — this change claims no clause, so record nothing; if that turns out to be wrong, add the row rather than leaving it implicit
- [x] 6.4 Close wayfinder ticket 018: post the answer, mark it closed, and add its one-line gist to the map's Decisions-so-far
