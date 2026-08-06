## 1. The identity seam, first because everything else imports it

- [x] 1.1 Move `AuthenticatedUser` and the request property name from `src/auth/auth.constants.ts` to `src/common/identity/authenticated-user.ts`, and `current-user.decorator.ts` from `src/auth/decorators/` to `src/common/identity/`. Re-point every import in `src/auth/`. The property name is declared as the `RequestWithUser` type rather than a string constant — a name TypeScript checks beats one it does not
- [x] 1.2 Add `@Public()` in `src/common/identity/public.decorator.ts` — not under `src/auth/`, because ticket 024's webhook route needs it from `billing/`, and `billing ──▶ auth` is the cycle this group exists to avoid — and have `JwtAuthGuard` read it through the `Reflector`, the same pattern `RolesGuard` already uses
- [x] 1.3 Register `JwtAuthGuard` as an `APP_GUARD` in `auth.module.ts`, not `app.module.ts`, so every module graph containing auth is guarded — including test harnesses that compose modules directly. Mark register, login, and refresh `@Public()`, and drop the now-redundant `@UseGuards(JwtAuthGuard)` from logout
- [x] 1.4 Confirm `test/auth-http.spec.ts` and `src/auth/auth-seam.spec.ts` pass unchanged — the three open routes still open, logout and the admin route still guarded

## 2. The draw split, written test-first

- [x] 2.1 `src/credit/services/draw-split.spec.ts`: subscription is exhausted before add-on is touched; a wallet with only add-on credits draws from add-on; an amount exceeding both ledgers reports the shortfall and no partial split; a single-ledger draw produces no zero-amount leg
- [x] 2.2 Implement `src/credit/services/draw-split.ts` — a pure function over the amount and the two balances, no Prisma, no Nest. It sits beside the service that uses it because a feature module's directory list has no place for a loose rules file

## 3. Consumption, written test-first against the test database

- [x] 3.1 `src/credit/services/credit.service.spec.ts`: a satisfiable consumption deducts in full and writes one row per ledger drawn from, each carrying its `balanceAfter`, and the result lists every row it wrote with its ledger and amount
- [x] 3.2 Test: a consumption larger than both ledgers together leaves both balances untouched, writes no row, and reports no transactions at all rather than an empty list
- [x] 3.3 Test: a two-ledger consumption of 120 against 100 and 50 writes two rows sharing one idempotency key, reports both, and leaves 0 and 30
- [x] 3.4 Test: the same key with the same amount returns the same rows the first call wrote, deducts nothing further, and adds no row
- [x] 3.5 Test: the same key with a different amount raises `IDEMPOTENCY_KEY_REUSED` and deducts nothing; the comparison is against the total across both ledgers
- [x] 3.6 Test: a wallet holding too little declines with `INSUFFICIENT_CREDITS` reporting both balances and the amount required; a `FROZEN` wallet declines with `BILLING_FROZEN` whatever its balance
- [x] 3.7 Test: replay outranks the freeze — a consumption succeeds, the wallet is frozen, the same request replays as the original success, and a *new* consumption on that wallet is still declined
- [x] 3.8 Test: a replay reports each drawn ledger's balance from the row that recorded it, and a ledger the original did not draw from as it currently stands
- [x] 3.9 Test: each decline increments the counter labelled by reason, a success increments nothing, and the increment happens outside the transaction
- [x] 3.10 Test: the caller's reason is stored on every row of a consumption, and stays null when none was supplied
- [x] 3.11 Test: an authenticated user with no wallet row raises `NotFoundError`
- [x] 3.12 Add `IDEMPOTENCY_KEY_REUSED` to `ERROR_CODES` in `src/common/errors/error-code.ts` and declare `IdempotencyKeyReusedError` in `src/credit/credit.errors.ts`
- [x] 3.13 Add `src/credit/credit.constants.ts` — the decline counter name, its label key, and the decline reason union. The reasons are response contract, not `ErrorCode` members
- [x] 3.14 Implement `repositories/credit-wallet.repository.ts` — `lockByUserId(tx, userId)` via `$queryRaw … FOR UPDATE` with every identifier double-quoted, and the balance write. Both take the transaction client as their first parameter
- [x] 3.15 Implement `repositories/credit-transaction.repository.ts` — write the rows for a consumption, find `CONSUMPTION` rows by idempotency key, find reversals by the rows they reverse
- [x] 3.16 Implement `services/credit.service.ts` consumption in the order the tests fix: open the transaction, lock the wallet, `404` on a missing one, replay, key reuse, freeze, sufficiency, then write and return every row. Translate `P2002` on the composite unique into the replay rather than letting it surface. No network call, no metric, no event inside the transaction

## 4. Reversal, written test-first

- [x] 4.1 Test: reversing a two-ledger consumption restores both balances and writes one `REVERSAL` row per ledger, each linked through `reversesId`
- [x] 4.2 Test: reversing a consumption that drew only from the add-on ledger restores add-on and leaves subscription unchanged
- [x] 4.3 Test: the `REVERSAL` rows carry neither an idempotency key nor a reason — reusing the consumption's key would collide on `@@unique([idempotencyKey, ledger])`, and `reversesId` already records what they undo
- [x] 4.4 Test: a repeated reversal returns the first reversal's result, adds no row, and leaves the balance where the first left it
- [x] 4.5 Test: a reversal against a `FROZEN` wallet restores the credits; a key with no consumption behind it raises `NotFoundError`
- [x] 4.6 Implement reversal in `services/credit.service.ts` — lock the wallet, replay if reversals already exist, otherwise write one `REVERSAL` per original row and restore each ledger. Translate `P2002` on `reversesId` into the replay. The result reports what was restored, the resulting balances, and the rows written, and carries no `success` flag

## 5. Constraints asserted by violating them

- [x] 5.1 Extend `test/ledger-invariants.spec.ts`: a second `CreditTransaction` with a `reversesId` already used is rejected by `reversesId @unique`
- [x] 5.2 Confirm the existing negative-balance and composite-key cases still assert what this change relies on, and leave them as the named tests for the two clauses already `covered`

## 6. Concurrency

- [x] 6.1 `test/credit-concurrency.spec.ts`: 30 parallel callers over separate connections consuming 10 each from a wallet holding 100 and 50 — exactly 15 succeed, both balances land on 0, the `CONSUMPTION` row count matches the successes, and nothing errors
- [x] 6.2 Test: two identical requests carrying one key, fired in parallel, both return the same transaction ids and the amount is deducted once
- [x] 6.3 Assert on outcome only, never on timing, and never wrap the test in a transaction — the suite truncates, per ticket 010. The ledger declares its own transaction `maxWait` and `timeout`: the 2s default rejected the callers at the back of the queue with a server error, which the concurrency requirement forbids

## 7. The HTTP surface

- [x] 7.1 Add `dto/consume-credits.dto.ts` — amount a positive integer, idempotency key a required non-empty string, reason optional — and `dto/reverse-credits.dto.ts`
- [x] 7.2 Add `controllers/credit.controller.ts` serving `POST /v1/credits/consume` and `POST /v1/credits/reverse`, reading the user id from `@CurrentUser()`, with no business logic and no user id accepted from the body
- [x] 7.3 Add `credit.module.ts` importing `PrismaModule` and `MetricsModule`, and register it in `app.module.ts`
- [x] 7.4 `test/credit-http.spec.ts`: consume and reverse end to end; the success body carries `consumed`, `balance`, and `transactions`, a decline carries `success: false`, a reason, and no `transactions` field, and a reversal carries no `success` field; `IDEMPOTENCY_KEY_REUSED` renders as `400` in the standard envelope
- [x] 7.5 Test: both routes return `401 UNAUTHORIZED` for an absent, malformed, expired, and refresh-typed token, and deduct nothing
- [x] 7.6 Test: a request carrying a user id in its body deducts the token holder's wallet; a zero, negative, or non-integer amount is `400 VALIDATION_FAILED`

## 8. Boundaries and close out

- [x] 8.1 Add `src/credit/credit-seam.spec.ts`: fails if any file under `src/credit/` imports from `src/billing/`, `src/user/`, or `src/auth/`
- [x] 8.2 Amend `docs/architecture/module-boundaries.md`: record that guards are registered at the composition root and that the verified identity is published by `common/identity/`, so a leaf module is authenticated without an edge back to `auth`
- [x] 8.3 Amend `docs/architecture/api-surface.md`: replace the scalar `transactionId` in the consume response with `transactions: [{ id, ledger, amount }]` and say why one id cannot name a two-ledger consumption; record that a decline omits the field; add the reversal response shape, which carries no `success`; state the token both credit routes require
- [x] 8.4 Run `npm run build`, `npm test`, and `npm run lint`; all three pass
- [x] 8.5 Confirm `prisma/schema.prisma` is unmodified, no migration was generated, and no configuration key was added
- [x] 8.6 Update `docs/testing/requirement-coverage.md`: move the eight claimed Section 6 clauses to `covered`, each with the name of the test that asserts it
- [x] 8.7 Close wayfinder ticket 021: post the answer, mark it closed, and add its one-line gist to the map's Decisions-so-far
