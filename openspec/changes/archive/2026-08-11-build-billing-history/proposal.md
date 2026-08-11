## Why

Implements wayfinder ticket [033 Build billing history](../../../docs/wayfinder/tickets/033-build-billing-history.md).
Three ledgers record everything a user's billing history is made of and nothing reads them together;
`requirement-coverage.md` has no Section 8 table, so §8 is tracked by nothing.

## What Changes

- `GET /v1/me/history` returns one merged, newest-first page over `PaymentTransaction`,
  `CreditTransaction`, and `SubscriptionEvent`, computed on read. Nothing is materialized.
- Filters `type`, `from`, `limit`, `cursor`; `type` names whole sources and one left out is unread.
- Cursor pagination over the total order `(occurredAt, source, id)`. A cursor on time alone is not a
  total order across three tables and would skip or repeat rows at a page boundary.
- A row is a discriminated union on `source`, so money cents and credit counts never share a field.
- Payments appear at every status, `PENDING` and `FAILED` included, each row carrying its status.
- `GET /v1/admin/users/:userId/billing` embeds the first history page and accepts a cursor.

## Capabilities

### New Capabilities
- `billing-history`: the merged read-only view over the three ledgers, its filters, its cursor order.

### Modified Capabilities
- `admin-billing-view`: the admin route answers with a history page beside subscription and balances.

## Impact

Clauses moved off `todo`, quoted from requirements §8 as new Section 8 rows:

- "The system must maintain complete billing and credit history."
- "Billing History is a derived view. Source ledgers are: Payment Transactions. Credit
  Transactions. Subscription Events."
- "It does not duplicate events from the source ledgers."

Code: new `history.service.ts`, `me-history.controller.ts`, `history-query.dto.ts`, a
`SubscriptionEvent` repository; listings on `PaymentTransactionRepository`, `CreditService`, and
`CreditTransactionRepository`; `AdminBillingViewService` extended. Read-only — no schema change.

Test budget: 4 new tests, under the ceiling of 10.
