## Context

`src/credit/` does not exist. The tables do: `CreditWallet` with its two non-negative `CHECK`s,
`CreditTransaction` with `@@unique([idempotencyKey, ledger])` and `reversesId @unique`. Nothing
writes to either, and `ledger-invariants.spec.ts` currently asserts the constraints by violating them
directly through Prisma.

Decisions already closed are not reopened here:

- `SELECT … FOR UPDATE` in an interactive transaction, with the split computed in application code;
  Serializable rejected on measurement —
  [006](../../../docs/wayfinder/tickets/006-prototype-atomic-consumption.md)
- one row per ledger sharing the caller's key, and the composite unique that allows it — same ticket,
  already migrated
- what a replay returns, both rows of it —
  [021](../../../docs/wayfinder/tickets/021-build-credit-consumption.md), settled 2026-08-05
- declines are `200`, faults are status codes —
  [011](../../../docs/wayfinder/tickets/011-design-api-surface.md)
- truncate per test, no transaction rollback, real connections for concurrency —
  [010](../../../docs/wayfinder/tickets/010-decide-testing-strategy.md)
- `credit` is a leaf that never reads `billing`, `user`, or `auth` —
  [004](../../../docs/wayfinder/tickets/004-design-module-boundaries.md)

## Goals / Non-Goals

**Goals:**

- Deduct atomically, in the right order, under contention, exactly once per key.
- Make every rule that a constraint enforces observable by attempting the violation.
- Leave the ledger writable by allocation (022), registration (023), and add-on purchase (032)
  without either of them reaching into the wallet row directly.

**Non-Goals:**

- No allocation, no freeze transition, no unfreeze. This change *reads* `WalletStatus`; ticket 022
  writes it.
- No wallet creation. Consumption against a user with no wallet is a `404`.
- No admin adjustment, no add-on purchase, no wallet or history read endpoint.
- No schema change, no migration, no configuration key.
- No batching, no reservation, no partial fulfilment. A consumption is all or nothing.

## Decisions

**The wallet row is locked with `$queryRaw … FOR UPDATE`, and every identifier in it is
double-quoted.** Postgres folds unquoted identifiers to lower case, so `FROM CreditWallet` resolves
to a nonexistent `creditwallet` — this has already cost this project one failure. The lock statement
is the only place type safety is lost; the decision, the arithmetic and the writes stay typed. The
`PrismaPg` adapter runs over TCP, which is what makes an interactive transaction possible at all —
Neon's HTTP driver does not support one.

**The split across ledgers is a pure function, `services/draw-split.ts`, and it is the unit written
first.**
`split(amount, { subscription, addon })` returns what to take from each or reports the shortfall. It
is the only piece of this path with arithmetic worth testing without a database, and keeping it out
of the SQL is exactly why ticket 006 chose `FOR UPDATE` over the conditional `UPDATE`, whose `LEAST`
expression could not be unit tested and needed a second query to tell the two decline reasons apart.

**The replay decision is made under the lock, before writing.** Having locked the wallet, the service
looks for existing `CONSUMPTION` rows carrying the key. The lock is what makes this read reliable:
two concurrent retries of the same key contend for the same row, so the second reads after the first
commits rather than racing it. A `P2002` on the composite unique is still caught and translated into
the same replay, because the constraint — not this read — is the guarantee of record, and a violation
must not surface as a `500`.

**A repeated key with a different total amount is a `400`, and the comparison is against the sum of
the stored rows.** A two-ledger consumption of 120 is stored as `-100` and `-20`; the caller sent one
number and gets one number compared back. `IDEMPOTENCY_KEY_REUSED` is a new member of the `ErrorCode`
union; the exception class raising it lives in `src/credit/credit.errors.ts`, because the union is a
platform contract but the rule is a credit rule.

**The response reports every row it wrote, as `transactions: [{ id, ledger, amount }]`, and the
scalar `transactionId` in `api-surface.md` is replaced.** A consumption spanning both ledgers writes
two rows, and one id can only name one of them; a rule such as "the row for the ledger drawn first"
is deterministic but silently hides the second row from the caller that may need to reconcile it.
Keeping the scalar was rejected — the field would be a lie in exactly the case the two-ledger design
exists for.

This changes a published contract, which is affordable now and only now: no application has
integrated against `/v1/credits/consume` yet, because this change is what first serves it. After one
has, the same widening costs a `/v2`. `api-surface.md` is amended in this change rather than left to
disagree with the code.

A replay therefore returns the stored rows, which is also what makes "the first call's ids"
well-defined without a tie-break rule.

**A decline omits `transactions` entirely rather than reporting an empty array.** A decline writes no
row; `[]` invites a caller to believe rows exist and were merely not listed.

**`reverse` has no `success` field.** Consumption has one because it has business outcomes — a
shortfall and a frozen wallet are both `200` with `success: false`. Reversal has no such branch: a
frozen wallet is reversed anyway, an unknown key is a `404`, and a repeat is the replay. A field that
is always `true` is a field callers learn to ignore.

**Inside the lock the order is fixed: missing wallet, replay, key reuse, freeze, sufficiency.** The
load-bearing pair is replay before freeze. A consumption succeeds, the subscription then goes past
due and ticket 022 freezes the wallet, and the caller — who timed out and never saw the first
response — retries. Checking the freeze first answers `BILLING_FROZEN` to a caller whose credits are
already gone, so it abandons or re-charges work it has in fact paid for, and nothing in the ledger
records that anything went wrong. A retry must be indistinguishable from the success it replays; the
freeze governs *new* consumptions.

**The caller's `reason` is stored on every row a consumption writes, and reversal rows carry none.**
`CreditTransaction.reason` exists and nothing writes it today. Both legs of a two-ledger consumption
describe one operation, so both carry the same string; absent, it stays `NULL`. A reversal's
relationship is already carried by `reversesId`, and a synthesised string like `"reversal of …"`
would duplicate the link in a form nothing can query.

**A reversal row carries no idempotency key.** Copying the consumption's key onto its reversal would
collide on `@@unique([idempotencyKey, ledger])` — same key, same ledger — and the reversal would be
unwritable. `NULL` keys are mutually distinct in Postgres, which the constraints file already records
as load-bearing, and at-most-once is carried entirely by `reversesId @unique`.

**A reversal is looked up by the consumption's key and replays like a consumption.** The request body
is `{ idempotencyKey }`, the original consumption's. A second identical request returns `200` with the
first reversal's result rather than an error: the caller is retrying after a timeout, and the same
reasoning that makes a repeated consumption a `200` applies unchanged. "Reversed at most once" is
about rows written, not about requests refused, and the `reversesId` unique is what holds it — a
`P2002` on it is translated into the replay, never surfaced. A key with no consumption behind it is a
`404`.

**A frozen wallet does not block a reversal.** Freezing stops credits leaving; a reversal puts them
back. Refusing it would strand credits the caller has already been charged for, at the moment the
user is least able to spare them. Only consumption reads `WalletStatus`.

**Both ledger balances in a replay response come from the stored rows where a row exists, and from
the wallet where one does not.** A consumption that drew only from subscription wrote no add-on row,
so no snapshot of the add-on balance at that instant exists. Reconstructing one would mean replaying
every later transaction. The replay therefore reports the touched ledger as it was and the untouched
ledger as it is — identical in the case the contract is for, a retry seconds later, and stated in the
spec so it is a known property rather than a surprise. See Risks.

**The guard moves to the composition root; the identity it publishes moves to `common/`.** The credit
controller needs an authenticated user id, and importing `JwtAuthGuard` from `src/auth/` would close
the cycle `auth ──▶ billing ──▶ credit ──▶ auth` that `module-boundaries.md` forbids in as many
words. So `JwtAuthGuard` is registered once as an `APP_GUARD` in `app.module.ts`, `@Public()` marks
the routes that do not need it — the three open auth routes today, the Stripe webhook in ticket 024 —
and `AuthenticatedUser`, the request property name, and `@CurrentUser()` move to
`src/common/identity/`. Every module is downstream of `common`, so no edge is added to the graph.

The seam is unchanged by this and arguably sharper: `auth` still owns the guard's implementation and
`AuthCredential` still appears nowhere outside it. What `common` holds is the *shape* of a verified
identity, which is precisely what survives the auth module's deletion — an upstream Authentication
Service arrives as a different guard assigning the same property.

Considered and rejected: re-declaring `@CurrentUser()` inside `credit`, which would repeat the
request property name in two modules — the failure mode `module-boundaries.md` names, a string two
files must agree on, silently reading `undefined` when one of them changes.

**`credit` gets a repository layer, one per aggregate.** `module-boundaries.md` already names it as
qualifying, and it does: raw SQL sits next to Prisma calls, and there are two aggregates.
`CreditWalletRepository` is where the `FOR UPDATE` statement and its double-quoted identifiers live —
the specific thing the document names — and `CreditTransactionRepository` is the only place that
knows what a ledger row must carry. Both take the transaction client as their first parameter; the
service owning the flow is the only thing that opens a transaction.

**Pure domain rules live under `services/`, not at the module root.** `billing/stripe/` keeps
single-purpose files like `webhook-signature.ts` loose, but that is an adapter directory and a
different shape. A feature module's directory list in `module-boundaries.md` has no entry for a file
of pure rules, and `draw-split.ts` sits beside the one service that uses it rather than growing a
fourth thing at the root or a `domain/` layer the document does not describe.

**No network call, no metric, and no event happens inside the transaction.** The decline counter is
incremented after the transaction closes, on the way out of the service. A counter incremented inside
a transaction that later rolls back would count a decline that never happened.

**The file layout this change lands:**

```
src/
  credit/
    controllers/credit.controller.ts
    services/credit.service.ts
    services/credit.service.spec.ts
    services/draw-split.ts
    services/draw-split.spec.ts
    repositories/credit-wallet.repository.ts
    repositories/credit-transaction.repository.ts
    dto/consume-credits.dto.ts
    dto/reverse-credits.dto.ts
    credit.constants.ts
    credit.errors.ts
    credit.module.ts
    credit-seam.spec.ts
  common/
    identity/authenticated-user.ts
    identity/current-user.decorator.ts
```

`credit.constants.ts` holds the decline counter name and its label key — the strings
`credit.service.ts` and `test/credit-http.spec.ts` must agree on. The decline reasons themselves are
part of the response contract and are declared there too, as a union; they are not `ErrorCode`
members, because a decline is not a fault.

## Risks / Trade-offs

- **`FOR UPDATE` serialises every consumption for one user behind one row lock.** → That is the
  point, and the contention is per wallet, not global. Ticket 006 measured thirty concurrent callers
  on one wallet at ~2.5s with no errors and no overselling.
- **A held lock plus a slow query holds a connection on a serverless database.** → The transaction
  contains no network call and no application wait: lock, arithmetic, two inserts, one update. Any
  future addition to this block is the thing to refuse.
- **A replay returns `success: true` from a wallet that is now frozen**, which reads oddly in a log.
  → It reports a success that already happened and writes nothing; the alternative charges the caller
  twice in effect, once in credits and once in abandoned work. A new consumption on that wallet is
  still declined.
- **`transactions` replaces `transactionId`, and `api-surface.md` had already published the scalar.**
  → No caller exists to break, and this change is the one that first serves the route. The window
  closes the moment an application integrates, which is the argument for widening now rather than
  discovering the need at `/v2`.
- **The untouched ledger's balance in a replay is current, not historical.** → Narrower than the
  phrase "the balances as they were then" in ticket 021, and deliberately so: the alternative is a
  wallet snapshot column pair on a money table, which is a migration and an ongoing write cost for a
  field that differs only when a retry arrives after an allocation. Written as a scenario so it is
  asserted rather than assumed.
- **Moving `@CurrentUser()` and the identity type out of `auth` touches a module this change is not
  about.** → Bounded: two files move, their imports re-point, and `auth-seam.spec.ts` still passes
  unchanged because it tracks `AuthCredential`, not the guard. The alternative is an import cycle the
  boundaries document forbids outright.
- **A global `APP_GUARD` makes "unauthenticated" opt-out rather than opt-in.** → That is the safer
  default for a service where every route but four requires a token: forgetting `@Public()` breaks a
  route loudly, forgetting `@UseGuards` leaks one silently. The four exceptions are asserted by test.
- **Two rows per consumption make history noisier than one.** → Required by the requirement that each
  transaction is tied to exactly one ledger, and already paid for in the schema.

## Migration Plan

None. No schema change, so no `migrate diff` and no `migrate deploy`. Were one needed, it would be
generated with `prisma migrate diff --from-config-datasource --to-schema` and applied with
`prisma migrate deploy` — never `db push`, and never `migrate dev` in a non-interactive shell.

No configuration key is added, so no `.env` or `.env.example` change.

The `APP_GUARD` registration changes the default for every route that exists after it lands. The
three open auth routes gain `@Public()` in the same commit; there are no other unguarded routes yet.

## Open Questions

None.

## Discovered during implementation

- **`APP_GUARD` belongs in `auth.module.ts`, not `app.module.ts`.** Registered at the root, the guard
  reaches only module graphs rooted at `AppModule`; `test/auth-http.spec.ts` composes `AuthModule`
  with a probe controller directly, so logout lost its guard and `@CurrentUser()` handed the service
  an `undefined` user — a `500` where a `401` belonged. Registering it in the module that owns it
  means a graph containing auth is authenticated by definition, which is the property the global
  guard was chosen for. Test harnesses then run production semantics rather than a weaker copy.
- **The ledger transactions declare their own `maxWait` and `timeout`; the defaults break the
  concurrency requirement.** Prisma waits 2s by default to *start* an interactive transaction. Thirty
  callers against one wallet queue behind both the connection pool and the row lock, and the ones at
  the back were rejected with `Unable to start a transaction in the given time` — a server error,
  where the spec says a caller that cannot be satisfied is declined and never errored. `maxWait` and
  `timeout` are now named in `credit.constants.ts`. Waiting is the right answer here because the lock
  is per wallet: only one user's own concurrent calls queue, and failing them would refuse work that
  is fully payable. Worth knowing for operations: the `pg` pool still defaults to ten connections,
  which caps how many of those transactions run at once.
- **`@Public()` lives in `common/identity/`, not `src/auth/decorators/`.** Ticket 024's webhook route
  is the one route that bypasses authentication entirely, and it lives in `billing/`. Sourcing the
  decorator from `auth` would give `billing ──▶ auth` — the same cycle this group exists to avoid.
- **A body naming a user is a `400`, not an ignored field.** The plan expected the extra property to
  be silently dropped and the token's wallet deducted. The global pipe runs with
  `forbidNonWhitelisted`, so the request is refused before the controller — a stronger guarantee than
  the one specified, and the scenario now states it.
- **The request property is declared as a type, `RequestWithUser`, not a string constant.** The rule
  it satisfies is that a name two files agree on is declared once; a type does that and is checked at
  every use, where `request[REQUEST_USER_PROPERTY]` would defeat the checker to enforce the same rule
  by hand.
