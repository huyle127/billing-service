# Testing Strategy

## What "covered" means

**A requirement clause with observable behaviour is covered when a named test asserts it.** Coverage
percentage is measured but is not the completion criterion.

The destination is a *feature-complete* service, which is a claim about requirements, not about
lines executed. A billing service can reach ninety percent line coverage and still mishandle a
subscription stuck in payment authentication, or double-allocate when the annual cron catches up
across missed months. The checklist in [requirement-coverage.md](requirement-coverage.md) is what
answers "what is still missing"; coverage output is a secondary signal for finding code nothing
touches.

## How much to test

**At most ten new tests per OpenSpec change.** Exceeding the ceiling is allowed, but the reason
must be stated in that change's proposal, so the overrun is a decision rather than a drift.

The ceiling exists because the completion criterion above is easy to over-serve. A clause is
covered when *one named test* asserts it; writing four tests around the same clause buys nothing
and costs on every future change that has to keep them passing. Ticket 023 added 24 tests to close
three clauses, and the extra tests were not the ones that found the two real bugs.

**Test what can break silently:**

- Rules enforced by the database — constraints, partial indexes, unique columns. Asserted by
  attempting the violation, never by trusting the code path.
- Concurrency. Two callers racing the same row, asserted on the outcome rather than on timing.
- Money and credits. Balances, arithmetic, and the boundaries where a draw splits across ledgers.
- Idempotency. The second call under the same key writes nothing.
- Transaction rollback. The whole unit lands, or none of it does.

**Do not test:** every field of a row that was just created, DI and module wiring, the text of a
log line, exact backoff numbers, or a happy path already covered by another test asserting the
same behaviour. These fail loudly the moment they are wrong — the compiler, the boot sequence, or
the next test catches them — so a test is a second copy of an assertion already being made.

The distinction is whether a wrong answer is *visible*. A missing credit is not; a missing
provider is.

## Runner

**Vitest**, with `unplugin-swc`.

Vitest rather than Jest for a reason specific to this project: it runs on TypeScript 6, which is
recent enough that this project already had to downgrade once to work around it. `ts-jest` is a
transform layer that tracks TypeScript releases and typically lags a major version by months.
Vitest transforms through esbuild and swc, which do not depend on the TypeScript compiler at all.

**`unplugin-swc` is not optional.** Vitest's default esbuild transform does not emit
`emitDecoratorMetadata`, and NestJS constructor injection depends on it. Without the plugin, every
test that builds a testing module fails to resolve dependencies, with an error that does not point
at the cause.

`fileParallelism` is disabled: database tests truncate shared tables, so parallel files would
destroy each other's fixtures.

## Test database

**A separate `billing_test` database on the same Neon project**, truncated before each test.

Configured through `DATABASE_URL_TEST` and `DIRECT_URL_TEST`. `test/setup.ts` refuses to run if
either is unset or if the test URL matches the development one — the suite truncates every table,
so a misconfiguration would destroy the development database rather than fail.

Reference data is deliberately **not** truncated. `Plan` and `AddonPackage` are seeded once when
the test database is created; truncating them would force every test to rebuild the catalog.

**A migration reaches this database only when it is deployed against it.** `prisma migrate deploy`
reads `DIRECT_URL`, so applying a new migration to the development database leaves `billing_test` a
schema behind, and every test touching the new column fails with `does not exist` rather than with
anything that names the cause. Point `DIRECT_URL` at `DIRECT_URL_TEST` for one run and deploy again.

### Why not transaction rollback per test

The usual trick — open a transaction, run the test inside it, roll back — was rejected. Credit
consumption opens its own `$transaction` internally, so a test-owned outer transaction would nest,
and rollback would no longer mean what the test expects. Making it work would require injecting a
transaction client from the test down through the repository layer, bending production code to suit
the test harness.

It also cannot express the test that matters most on that path: concurrent consumption. Two callers
racing for the same wallet must use two connections, which a single wrapping transaction forbids.

### Why not a Neon branch per run

Branch-per-run gives stronger isolation and would allow parallel CI. It needs a Neon API key in the
environment and leaves orphaned branches when teardown fails. Since the destination is a locally
running service with no CI, a fixed test database is enough. Revisit if parallel runs are needed.

## Layers

**Unit** — domain rules with no database and no Stripe. Draw order, plan entitlement arithmetic,
allocation-key construction, subscription state transitions. Fast, and where `/tdd` applies.

**Integration** — real test database, Stripe faked at the adapter seam. Everything involving
transactions, constraints, or the webhook pipeline. This is where the invariants live, and where
database-enforced rules are proven to actually reject violations rather than assumed to.

**Lifecycle** — Stripe test clocks against a sandbox. Run deliberately, not as part of the standard
suite: they are sandbox-only, rate limited to twenty invoices per subscription per day, capped at
two intervals per advance, and auto-deleted after thirty days.

## Faking Stripe

Ticket 003 eliminated two of the obvious options.

**`stripe-mock` is unusable** for anything stateful. It is stateless by design and Stripe has stated
it will remain so, which rules out every subscription lifecycle scenario.

**`stripe trigger` creates real objects and fires cascading events**, so a test asserting on one
event receives several. It is useful only for smoke-testing that the signature verification and
raw-body path work at all.

**Webhook tests construct their own event payloads and sign them** with the test signing secret.
This needs no network, is deterministic, and can produce sequences Stripe would rarely emit —
including the out-of-order arrivals requirements §5 demands the processor tolerate.

**Test clocks are the only way to advance a subscription through months** without waiting. They
move Stripe's clock, not ours, which is why the injectable application clock exists — the annual
allocation cron reads our time, and a Stripe test clock does not touch it.

Test clocks **cannot fail a payment during advancement**, so dunning and `past-due` scenarios need a
declining test card attached before the clock advances.

## Time

Domain code never calls `new Date()`. Time arrives through the injectable clock from
`common/clock`, and tests set it explicitly. Without this the cron's catch-up across missed months,
and the rule that allocation stops at the paid-through boundary, cannot be tested at all.

## Retry and dead-lettering

Backoff intervals come from configuration, so tests set them to zero and drive the worker directly
rather than waiting for real delays. The dead-letter path is asserted by exhausting the retry
budget, not by sleeping.

## Concurrency

Concurrency tests use real parallel connections and assert on the outcome, not on timing. The
pattern is established: fire N callers at a wallet holding fewer credits than they collectively
request, then assert that exactly `floor(balance / amount)` succeed, the balance lands on its floor,
and the transaction count matches the successes. Ticket 006 used this to eliminate Serializable
isolation, which passed every sequential test and lost a third of its requests under contention.
