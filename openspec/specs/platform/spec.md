# platform

## Purpose

Cross-cutting service infrastructure: time, configuration, the error contract, request validation,
metrics, and the raw-body exception that Stripe signature verification depends on. Every feature
module stands on this; it owns no domain behaviour of its own.

## Requirements

### Requirement: Time is injected, never read from the system clock

Domain code SHALL obtain the current time from an injectable clock in `common/clock` and SHALL NOT
call `new Date()` directly. A lint rule MUST enforce this outside `common/clock` itself.

This is not stylistic. A Stripe test clock advances *Stripe's* clock and not ours, so the annual
allocation cron's catch-up across missed months, and the rule that allocation stops at the
paid-through boundary, cannot be exercised at all unless our own time is settable by a test.

#### Scenario: A test controls what domain code believes the time is

- **WHEN** a test installs a fixed clock reading a chosen instant
- **AND** domain code asks for the current time
- **THEN** it receives that instant, not the machine's wall clock

#### Scenario: A direct system clock read is rejected before it reaches review

- **WHEN** `new Date()` or `Date.now()` appears in a source file outside `common/clock`
- **THEN** the lint run fails and names the offending file

### Requirement: Configuration is typed and validated at boot

The service SHALL read configuration through a typed accessor covering both database URLs, the JWT
secret and token lifetimes, `INTERNAL_API_KEY`, the Stripe secret key, the list of Stripe webhook
signing secrets, and the retry backoff intervals. A missing or malformed value MUST fail startup.

Backoff intervals are configuration specifically so tests can set them to zero and drive the worker
directly, rather than asserting the retry and dead-letter paths by sleeping.

#### Scenario: A missing required value stops the service starting

- **WHEN** a required configuration value is absent from the environment
- **THEN** startup fails with an error naming that value
- **AND** the service does not begin accepting requests

#### Scenario: A malformed value is refused rather than coerced

- **WHEN** a value declared as an integer cannot be read as a non-negative integer
- **THEN** startup fails with an error naming that value and the text it received

#### Scenario: Webhook signing secrets are a list, not a single value

- **WHEN** configuration supplies more than one Stripe webhook signing secret
- **THEN** all of them are available to the verifier

  The secret printed by `stripe listen` differs from the Dashboard's, and rotation must not require
  a redeploy.

#### Scenario: Every configuration accessor resolves

- **WHEN** the typed accessor is asked for each value it exposes
- **THEN** every one resolves without throwing

  The accessor reads namespaced values by string path, so a mistyped path is invisible to the
  compiler and would otherwise fail only when that value is first read in production.

### Requirement: Faults share one error envelope with a stable code

Fault responses SHALL use the shape `{ error: { code, message, details } }`. `code` is the stable
contract that consumers branch on; `message` is for humans and MAY change. The kind of fault
determines the HTTP status: client fault `400`, authentication `401`, authorization `403`, missing
resource `404`, server fault `5xx`.

Business outcomes are not faults and are out of scope here — they return `200` with a result object,
which is why the decline counter below exists.

#### Scenario: A domain exception renders as the envelope

- **WHEN** a service throws an exception carrying a stable code
- **THEN** the response body is the envelope with that code
- **AND** the HTTP status matches the fault kind, not the code

#### Scenario: Validation failure is a client fault

- **WHEN** a request body fails DTO validation
- **THEN** the response is `400` in the envelope shape
- **AND** the controller performs no validation of its own

#### Scenario: An unhandled fault reveals nothing about its cause

- **WHEN** an exception carrying no stable code reaches the boundary
- **THEN** the response is `500` with code `INTERNAL_ERROR` and a generic message
- **AND** the original message and stack appear only in the service log

### Requirement: Routes are versioned from the first release

All routes SHALL be served under the `/v1` prefix.

The credit consumption endpoint is called by other applications, so changing its contract later
without a version would break them silently.

#### Scenario: An unversioned path does not resolve

- **WHEN** a request arrives at a route path without the `/v1` prefix
- **THEN** it does not reach the controller

### Requirement: Counters can be recorded for business outcomes

The service SHALL expose a counter interface in `common/metrics` that records a named metric with
labels.

Its first consumer is the declined-consumption counter. Because a decline is reported with a `200`
status, no gateway, log aggregator, or dashboard can infer one from the response, and a user refused
a thousand times would otherwise look identical to a thousand successes.

#### Scenario: A counter increments with its labels

- **WHEN** code records a counter with a name and a label set
- **THEN** the recorded value for that name and label set increases by one
- **AND** a different label set is counted separately

#### Scenario: Label order does not create a separate counter

- **WHEN** the same labels are supplied in a different order
- **THEN** both records land on the same counter

### Requirement: The Stripe webhook route receives the unparsed request body

A handler SHALL be able to read the exact bytes of the request body at `POST /v1/webhooks/stripe`,
and every other route SHALL continue to receive a parsed JSON body.

Stripe signature verification is computed over the exact bytes received. The global JSON parser
consumes and re-serialises the body, and the resulting failure presents as a signature mismatch
rather than as a parsing problem — which is why this is specified rather than left to whoever wires
the webhook controller.

This is stated as an outcome rather than a mechanism. NestJS's `rawBody` option buffers the raw body
for every route alongside the parsed one, which satisfies both clauses above; hand-wiring a
route-scoped parser would satisfy them too, at the cost of replacing the framework's body handling
with our own on the one path where a mistake is silent.

#### Scenario: The webhook handler sees the exact bytes sent

- **WHEN** a request with a JSON body arrives at `POST /v1/webhooks/stripe`
- **THEN** the handler can read the unmodified raw body
- **AND** signature verification over those bytes succeeds for a correctly signed payload

#### Scenario: Other routes still receive parsed JSON

- **WHEN** a request with a JSON body arrives at any other route
- **THEN** the handler receives the parsed object as normal
