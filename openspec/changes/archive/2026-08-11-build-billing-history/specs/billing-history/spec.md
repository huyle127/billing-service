## ADDED Requirements

### Requirement: History is one merged view derived from the three source ledgers
`GET /v1/me/history` SHALL answer with the caller's `PaymentTransaction`, `CreditTransaction`, and
`SubscriptionEvent` rows merged into one newest-first page, computed on read. It SHALL write nothing.
Each row SHALL carry a `source` discriminator and only the fields of that source, so money cents and
credit counts never share a field. Subscription events SHALL span every subscription the caller has
ever held, not only the current one.

#### Scenario: A page carries all three sources in one descending order
- **WHEN** a user holding a payment, a credit transaction, and a subscription event on an expired
  subscription reads `GET /v1/me/history`
- **THEN** one page returns all three, newest first, each tagged with its source, with the payment
  carrying `amountCents` and the credit row carrying `amount` and `balanceAfter`

### Requirement: The cursor encodes a total order across the three tables
The page cursor SHALL encode `(occurredAt, source, id)` and the merge SHALL sort on all three. Two
rows sharing an `occurredAt` in different source tables SHALL therefore hold a stable relative
position, and paging through SHALL return every row exactly once.

#### Scenario: Rows sharing a timestamp are neither skipped nor repeated at a page boundary
- **WHEN** three rows in three different source tables carry the identical `occurredAt` and the
  history is read one row per page
- **THEN** the three pages return the three rows, each exactly once and in the same order the
  unpaged read gives

#### Scenario: A row inserted at the head does not shift a page already cursored past
- **WHEN** a page is read, a new transaction is then written, and the next page is fetched with the
  returned cursor
- **THEN** the second page continues from the first row's predecessor and repeats no row from the
  first page

### Requirement: Filters select whole sources and a time floor
`type` SHALL accept a comma-separated subset of `payment`, `credit`, and `subscription`, and a source
absent from the list SHALL NOT be queried. `from` SHALL exclude rows older than the given instant.
`limit` SHALL bound the page. An unrecognised `type` value SHALL be refused `400 VALIDATION_FAILED`.

#### Scenario: An excluded source contributes no rows
- **WHEN** a user with rows in all three ledgers reads `GET /v1/me/history?type=credit`
- **THEN** only credit rows return, and a value outside the three names is refused
  `400 VALIDATION_FAILED`

### Requirement: A payment appears at every status
A `PaymentTransaction` SHALL appear in history whatever its status, and its row SHALL carry that
status. A purchase awaiting confirmation SHALL be visible before it settles, and one that failed
SHALL remain visible afterwards.

#### Scenario: Pending and failed payments are both present
- **WHEN** a user holds one `PENDING`, one `FAILED`, and one `SUCCEEDED` payment and reads history
- **THEN** all three return, each carrying its own status
