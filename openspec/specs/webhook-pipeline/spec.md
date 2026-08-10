# webhook-pipeline

## Purpose

How a Stripe event is received, authenticated, recorded, made idempotent and dispatched — independent
of what any handler does with it. It owns the one route that bypasses the auth guards, the ordering
that keeps a record of an event whose processing failed, and the distinction between a failure and a
deferral. Retry is Stripe's: a non-2xx answer is the request to redeliver.

## Requirements

### Requirement: The endpoint verifies the signature against the raw body

`POST /v1/webhooks/stripe` SHALL verify the Stripe signature against the unparsed request body,
accepting any secret in a configured list, and SHALL reject an event that verifies against none of
them without persisting it. The route SHALL bypass the authentication guards.

#### Scenario: A forged signature is rejected and stored nowhere

- **WHEN** a request arrives whose signature matches no configured secret
- **THEN** the response is `400` and no `WebhookEvent` row exists for it

#### Scenario: Either configured secret is accepted

- **WHEN** a request is signed with the second secret in the configured list
- **THEN** it is accepted and persisted

### Requirement: The event is recorded before it is processed

The endpoint SHALL commit the `WebhookEvent` row before processing begins, in a transaction separate
from the one processing uses, so that a handler failure leaves the record intact. It SHALL then
process the event and answer 2xx only once processing has succeeded.

#### Scenario: A handler failure still leaves the event on record

- **WHEN** a validly signed event is received and its handler fails
- **THEN** the response is not 2xx and a `WebhookEvent` row exists carrying the failure reason

#### Scenario: A processed event is acknowledged

- **WHEN** a validly signed event is received and its handler succeeds
- **THEN** the response is 2xx and the row's status is `COMPLETED`

### Requirement: A redelivered event is judged by its recorded status

A redelivery SHALL NOT create a second row. An event already recorded `COMPLETED` SHALL be
acknowledged without being processed again. An event recorded in any other status SHALL be processed
again, because Stripe's redelivery is the retry mechanism.

#### Scenario: A completed event is not processed twice

- **WHEN** an event already recorded `COMPLETED` is delivered again
- **THEN** the response is 2xx, its handler does not run, and exactly one row exists for it

  The unique constraint on `stripeEventId` is what prevents the second row, so this is asserted by
  attempting the duplicate rather than by trusting a lookup.

#### Scenario: A failed event is retried on redelivery

- **WHEN** an event recorded `FAILED` is delivered again and its handler now succeeds
- **THEN** it is processed, the row's status becomes `COMPLETED`, and one row exists for it

### Requirement: Deferral is recorded distinguishably from failure

A handler SHALL report completed, failed, or deferred. Deferral and failure SHALL both be answered
non-2xx so Stripe redelivers, and SHALL be distinguishable in the stored row, a deferral recording
that the event's subject was absent.

#### Scenario: A deferral says the subject was missing

- **WHEN** a handler defers an event because its subject does not exist locally
- **THEN** the response is not 2xx and the row's recorded reason identifies it as a deferral rather
  than as a processing failure

### Requirement: Dispatch is by event type, and an unsubscribed type is not an error

The service SHALL route each event to the handler registered for its type. An event whose type has no
registered handler SHALL be recorded `COMPLETED` without work.

#### Scenario: An event reaches the handler that claims its type

- **WHEN** an event is processed
- **THEN** the handler registered for that event's type receives it

#### Scenario: An unsubscribed type is acknowledged

- **WHEN** an event whose type has no registered handler is received
- **THEN** the response is 2xx, the row is `COMPLETED`, and no failure is recorded
