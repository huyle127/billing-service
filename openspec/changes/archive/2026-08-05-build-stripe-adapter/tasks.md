## 1. Domain types and the interface

- [x] 1.1 Create `src/billing/stripe/` with the domain types the adapter returns — customer, subscription (id, status, `currentPeriodEnd`, price and product ids, `billingMode` lifted from `billing_mode.type`, metadata), price, product, payment method, invoice (including `status`), payment
- [x] 1.2 Declare `StripeService` as an abstract class, used as both the injection token and the type, covering: create and retrieve Customer; create, retrieve, update and cancel Subscription; create Product and Price; archive Price; attach and detach PaymentMethod; retrieve Invoice; create a one-time payment; find by our metadata; construct a webhook event
- [x] 1.3 Confirm no listing operation for Products or Prices appears on the interface, and that no domain type declares a `Stripe.` type in its shape

## 2. Error classification

- [x] 2.1 Add the domain Stripe error carrying a retryable/permanent verdict, the originating Stripe error type name, and the `requestId`
- [x] 2.2 Add the classifier mapping the SDK error families per the design table, defaulting unrecognised errors to permanent
- [x] 2.3 Test: connection, rate-limit, and 5xx API errors classify retryable; invalid-request, authentication, permission, signature, and card errors classify permanent; an unrecognised error classifies permanent
- [x] 2.4 Test: the Stripe `requestId` survives classification and is readable from the domain error

## 3. The fake

- [x] 3.1 Test first: a subscription created through the fake can be retrieved, updated, and cancelled, and each read reflects the writes before it; a cancelled subscription reports its cancellation rather than disappearing
- [x] 3.2 Test first: creating twice with the same derived idempotency key returns the first object and leaves exactly one behind
- [x] 3.3 Test first: an object created for a user is found by `metadata.userId`, and an identifier no object carries returns nothing rather than an unrelated object
- [x] 3.4 Implement `FakeStripeAdapter` against the interface — in-memory stores, counter-derived ids, an idempotency-key map, metadata search, and time from `common/clock`
- [x] 3.5 Add fault injection to the fake: an operation can be configured to fail as a rate limit or as an invalid request, raising the same domain error type the real adapter raises
- [x] 3.6 Test: the fake's injected failures carry retryable and permanent verdicts respectively

## 4. The real adapter

- [x] 4.1 Implement `StripeSdkAdapter` — construct the client with `apiVersion` pinned to `2026-07-29.dahlia` and the secret key from `common/config`
- [x] 4.2 Implement the operations, mapping SDK objects to the domain types; read `currentPeriodEnd` from the subscription item and `billingMode` from `billing_mode.type`
- [x] 4.3 Derive the idempotency key inside the adapter for every create — `customer:{userId}`, `subscription:{subscriptionId}`, the plan `code` for catalog writes — and reject any attempt to pass one in from a caller
- [x] 4.4 Attach `metadata.userId` to every created object and `metadata.subscriptionId` to created subscriptions
- [x] 4.5 Implement the metadata search; if a resource cannot be queried by metadata, narrow by customer id and filter in-process rather than exposing a list operation
- [x] 4.6 Implement webhook event construction against the **list** of signing secrets, accepting on any match and raising a permanent signature failure otherwise
- [x] 4.7 Wrap every SDK call so failures leave the adapter as classified domain errors, never as `stripe.errors.*`

## 5. Wiring and tests

- [x] 5.1 Add `StripeModule` providing `StripeService` via `useClass: StripeSdkAdapter`, exporting the token, and register it in `app.module.ts`
- [x] 5.2 Test: a testing module binding the token to the fake runs interface-written code unchanged and makes no network call
- [x] 5.3 Test: the client's configured `apiVersion` reads `2026-07-29.dahlia`, and event construction uses the same pinned version
- [x] 5.4 Test: a payload signed with the second configured secret verifies; one signed with an unknown secret fails permanently and returns no event; a payload altered after signing fails as a signature failure, using the fake's SDK-backed signing helper
- [x] 5.5 Test: every operation on the interface is answered by the fake rather than throwing "not implemented", and the two implementations declare the same signatures
- [x] 5.6 Test: no file outside `src/billing/stripe/` imports the `stripe` package

## 6. Constants and layout

- [x] 6.1 Create `stripe.constants.ts` holding the API version, the operation set, metadata keys, idempotency key builders, provider statuses, and the SDK error type names
- [x] 6.2 Derive `StripeOperation` from the operation set so a misspelled operation does not compile, and type `call`, `guard`, and `failNext` with it
- [x] 6.3 Replace every provider-facing literal in both adapters and the shared verifier with a reference to the constants module
- [x] 6.4 Test: the SDK adapter sends the derived idempotency key and the declared metadata keys, asserted against a stubbed client rather than the network
- [x] 6.5 Test: no file in the seam builds an idempotency key or a metadata path from a literal
- [x] 6.6 Record the binding directory layout and the no-literals rule in `docs/architecture/module-boundaries.md`
- [x] 6.7 Check what NestJS actually prescribes — read `@nestjs/schematics` — and state in the document that grouping by role is this repository's choice, not a framework convention
- [x] 6.8 Split the seam into `interfaces/`, `adapters/`, `types/`, correcting the suffixes: `.interface.ts` for the contract, `.adapter.ts` for the two implementations, and no `.port.ts`
- [x] 6.9 Remove the "adapter directories are flat" exemption from the document, since it exempted the only directory that existed

## 7. Close out

- [x] 7.1 Run `npm run build`, `npm test`, and `npm run lint`; all three pass, including the `new Date()` ban now that domain code exists outside `src/common/`
- [x] 7.2 Confirm `prisma/schema.prisma`, `prisma.config.ts`, and `.env` are unmodified, and that no configuration key was added
- [x] 7.3 Record the two design open questions' answers in `design.md` under *Discovered during implementation* — whether metadata search covers subscriptions, and whether the SDK's `apiVersion` union carries the pinned literal
- [x] 7.4 Update `docs/testing/requirement-coverage.md` — this change claims no clause, so record nothing; if implementation shows a clause is in fact fully asserted here, add its test name rather than leaving it implicit
- [x] 7.5 Close wayfinder ticket 019: post the answer, mark it closed, and add its one-line gist to the map's Decisions-so-far
