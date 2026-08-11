# stripe-adapter

## Purpose

The boundary between this service and Stripe: which operations exist, how duplicate creation is
prevented both inside Stripe's idempotency window and beyond it, how failures are classified for the
callers that retry, and the guarantee that a test can substitute a fake for the whole surface. It is
the only place the `stripe` SDK is visible; everything above it sees types this service declares.
## Requirements
### Requirement: Stripe SDK types stay inside the adapter

`src/billing/stripe/` SHALL be the only location where the `stripe` package is imported and where
its types appear in a signature. Every operation the adapter exposes SHALL take and return types
declared by this service.

Callers therefore never learn whether a period end lives on the subscription or on its items — a
question whose answer changed between two Stripe API versions.

#### Scenario: No module above the seam reaches for the SDK

- **WHEN** the source tree is searched for imports of the `stripe` package
- **THEN** every hit is inside `src/billing/stripe/`

#### Scenario: The exposed surface names no SDK type

- **WHEN** a caller outside `src/billing/stripe/` holds the result of any adapter operation
- **THEN** it compiles against types this service declares, with no `Stripe.` type in the path

### Requirement: The API version is pinned, not inherited

The adapter SHALL set `apiVersion` to `2026-07-29.dahlia` explicitly on the client and on webhook
event construction, rather than accept the account default.

The account default moves when Stripe upgrades it. Version `2025-03-31.basil` moved
`current_period_end` off the Subscription object onto its items and restructured Invoice; inheriting
that would have broken credit allocation with no error at either end.

#### Scenario: The configured version is the pinned one

- **WHEN** the adapter's client configuration is inspected
- **THEN** `apiVersion` reads `2026-07-29.dahlia`

#### Scenario: An event rendered under another version is visible, not silently accepted

- **WHEN** a verified event carries an `api_version` other than the pinned one
- **THEN** the version is readable on the returned event
- **AND** the mismatch is reported rather than passing unremarked

  The version an event is rendered under is set on the Stripe-side endpoint, which this service
  cannot configure from code. Rejecting the event would drop real traffic during a version change,
  so the adapter surfaces the mismatch instead.

### Requirement: The adapter exposes the operations the billing flows need

The adapter SHALL expose: create and retrieve Customer; create, retrieve, update and cancel
Subscription; create Product and Price; archive Price; attach and detach PaymentMethod; retrieve
Invoice; create a one-time payment; find a previously created object by our metadata; and construct
a webhook event from a raw body and signature header.

The list is fixed by the changes that depend on it. An operation absent here forces its caller to
reach past the seam.

#### Scenario: Every declared operation is answered by both adapters

- **WHEN** each operation on the interface is invoked against the fake
- **THEN** it returns a domain result rather than throwing "not implemented"
- **AND** the real adapter declares the same operation with the same signature

### Requirement: The adapter never enumerates the Stripe catalog
No operation SHALL list Products or Prices. A Price search scoped to an exact `metadata['code']`
value is permitted: it returns only objects this service named, and cannot reach the nine unrelated
products in account `acct_1TlhMSFaNFL0w4nv` that a list call returns.

#### Scenario: No listing operation exists to be called
- **WHEN** the adapter interface is inspected for an operation that lists Products or Prices
- **THEN** none exists, and the Price search requires a plan code to match

### Requirement: Creation calls carry an idempotency key derived from our identifiers
Every create call SHALL carry an `Idempotency-Key` computed from an identifier this service holds —
`customer:{userId}`, `subscription:{subscriptionId}`, and for a catalog write the plan `code` with
its interval, since one code carries both a monthly and an annual price. The adapter SHALL compute
it; callers SHALL NOT pass one.

#### Scenario: The key is present and derived, not random
- **WHEN** a Customer is created for a user
- **THEN** the call carries the idempotency key `customer:{userId}`
- **AND** creating a Subscription carries `subscription:{subscriptionId}`

#### Scenario: A retry inside the window returns the original object
- **WHEN** the same create operation is issued twice with the same derived key
- **THEN** the second call returns the object the first created
- **AND** no second object exists

#### Scenario: Two cycles of one code do not collide
- **WHEN** a monthly and an annual Price are created for one code at the same amount
- **THEN** the calls carry different keys and Stripe holds two distinct Prices

### Requirement: Every created object carries our identifiers in its metadata

Every object the adapter creates SHALL carry `metadata.userId`, and a created Subscription SHALL
also carry `metadata.subscriptionId`.

Stripe's idempotency keys expire after 24 hours. A retry after a longer outage falls outside the
window and the key protects nothing, so metadata is what remains. It is also the only thing that
makes an orphaned Stripe object traceable back to a user by anything other than guesswork.

#### Scenario: A created object is tagged

- **WHEN** the adapter creates a Customer, a Subscription, or a one-time payment
- **THEN** the resulting object carries `metadata.userId`
- **AND** a Subscription additionally carries `metadata.subscriptionId`

#### Scenario: An object is found again by the identifiers it was tagged with

- **WHEN** an object created for a user is searched for by `metadata.userId`
- **THEN** it is returned
- **AND** searching for an identifier no object carries returns nothing rather than an unrelated
  object

#### Scenario: A retry beyond the idempotency window adopts instead of duplicating

- **WHEN** a create is retried after its idempotency key has expired
- **AND** the metadata search finds the object created by the first attempt
- **THEN** the caller adopts that object
- **AND** no second object is created

### Requirement: Failures are classified as retryable or permanent

Every failure the adapter raises SHALL be a domain error carrying a verdict: **retryable** for
network failures, rate limits, and Stripe 5xx; **permanent** for invalid requests and anything else
a retry cannot change. The originating Stripe error type and request id SHALL be preserved for
diagnosis.

The webhook worker and the sync reconciler both branch on this. Without it a malformed request
retries until it exhausts its budget and lands in the dead letter queue, where it looks identical to
an outage.

#### Scenario: A transport or capacity failure is retryable

- **WHEN** the underlying call fails with a connection error, a rate limit, or a Stripe 5xx
- **THEN** the adapter raises a domain error whose verdict is retryable

#### Scenario: An invalid request is permanent

- **WHEN** the underlying call fails with an invalid-request error
- **THEN** the adapter raises a domain error whose verdict is permanent
- **AND** the caller can distinguish it from a retryable failure without inspecting an SDK type

#### Scenario: The Stripe request id survives classification

- **WHEN** a failure carrying a Stripe request id is classified
- **THEN** that request id is readable from the domain error

### Requirement: An absent object is an answer, not a failure

A retrieve operation SHALL return `null` when Stripe reports the object does not exist, and SHALL
raise a classified failure for every other error. Both implementations SHALL behave identically here.

An object that is not there yet is a normal state in this system, not a fault: webhook processing is
required to *defer* rather than fail when its subject is missing, and the sync reconciler asks about
objects it may not have created yet. If absence arrived as a permanent failure, the handler would
dead-letter the event instead of retrying it once the object appears.

#### Scenario: A retrieve of something that does not exist answers null

- **WHEN** a customer, subscription, or invoice is retrieved by an id Stripe reports as missing
- **THEN** the operation returns `null`
- **AND** the fake returns `null` for the same call

  These two must agree. While they did not, every test exercised the null path and production took
  the throwing one — a divergence invisible to the whole suite.

#### Scenario: A retrieve that fails for any other reason still raises

- **WHEN** a retrieve fails with an outage, a rate limit, or an authentication error
- **THEN** the adapter raises a classified domain error rather than returning `null`
- **AND** its verdict is unchanged by the absence handling

### Requirement: Webhook events verify against a list of signing secrets

The adapter SHALL construct a webhook event from the raw request body, the signature header, and the
**list** of signing secrets from configuration, accepting the event if any secret verifies it and
rejecting it otherwise. Rejection SHALL be a permanent failure.

The secret printed by `stripe listen` differs from the Dashboard's, and rotation must not require a
redeploy.

#### Scenario: A payload signed with any configured secret verifies

- **WHEN** a payload is signed with the second secret in the configured list
- **THEN** the event is constructed and returned

#### Scenario: A payload signed with an unknown secret is rejected

- **WHEN** a payload is signed with a secret that is not in the list
- **THEN** verification fails with a permanent error
- **AND** no event is returned

#### Scenario: A modified body no longer verifies

- **WHEN** a correctly signed payload is altered after signing
- **THEN** verification fails
- **AND** the failure is reported as a signature failure, not as a parse failure

### Requirement: Provider-facing names are declared once, not repeated as literals

Idempotency key prefixes, metadata keys, the pinned API version, operation names, and the provider
status values the adapter reads SHALL be declared in one constants module inside the seam, and every
use SHALL reference that declaration.

The failure this prevents is silent in every case. A metadata key written as `userId` on create and
queried as `user_id` in a search returns nothing, so the caller creates a second object and reports
success. Two implementations computing an idempotency key from separate literals make the test that
proves retries are safe prove it only about one of them.

#### Scenario: The seam builds no key from a literal

- **WHEN** the adapter's source files are inspected for an inline idempotency key or an inline
  metadata path
- **THEN** none is found outside the constants module

#### Scenario: The key a writer writes is the key a reader queries

- **WHEN** an object is created with our metadata and then searched for by the same identifier
- **THEN** both the write and the query are built from the same declared key

#### Scenario: An operation name cannot be misspelled

- **WHEN** code names an adapter operation — to classify its failure, or to make the fake fail it
- **THEN** the name is a member of the declared operation set
- **AND** a name outside that set does not compile

### Requirement: The whole Stripe surface can be replaced by a fake

A `FakeStripeAdapter` SHALL implement the same interface and SHALL be substitutable for the real
adapter by injection alone, with no change to calling code. It SHALL hold state across calls, so a
subscription created through it can then be retrieved, updated, and cancelled. It SHALL be able to
sign a payload with the test signing secret so a webhook test can produce a verifiable event without
a network call.

Ticket 003 closed the alternatives: `stripe-mock` is stateless by design and Stripe has said it will
remain so, and `stripe trigger` creates real objects and fires cascading events, so a test asserting
on one event receives several.

#### Scenario: A test swaps the implementation without touching the caller

- **WHEN** a testing module binds the Stripe injection token to the fake
- **THEN** code written against the interface runs unchanged
- **AND** no network call is made

#### Scenario: The fake carries a subscription through its lifecycle

- **WHEN** a subscription is created through the fake, then retrieved, updated, and cancelled
- **THEN** each read reflects the writes that preceded it
- **AND** the cancelled subscription reports its cancellation rather than disappearing

#### Scenario: The fake signs a payload a verifier accepts

- **WHEN** a test asks the fake to sign an event payload with the test signing secret
- **THEN** constructing an event from those bytes and that signature succeeds

#### Scenario: The fake fails the way the real adapter fails

- **WHEN** the fake is configured to fail an operation as a rate limit, and separately as an invalid
  request
- **THEN** the first raises a retryable domain error and the second a permanent one
- **AND** both are the same error type the real adapter raises

