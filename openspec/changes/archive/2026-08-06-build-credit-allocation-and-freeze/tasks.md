## 1. The role seam, first because the admin route imports it

- [x] 1.1 Move `roles.decorator.ts` from `src/auth/decorators/` and `roles.guard.ts` from
      `src/auth/guards/` to `src/common/identity/`, beside `authenticated-user.ts`,
      `current-user.decorator.ts` and `public.decorator.ts`. Re-point every import in `src/auth/`
- [x] 1.2 Register `RolesGuard` as a second `APP_GUARD` in `auth.module.ts`, after `JwtAuthGuard`, so
      every graph containing auth is authorised by definition — the same reasoning that put
      `JwtAuthGuard` there in ticket 021
- [x] 1.3 Drop `@UseGuards(JwtAuthGuard, RolesGuard)` from the probe controller in
      `test/auth-http.spec.ts` and confirm the suite still passes: the admin probe still `403`s a user
      token and `401`s an absent one with no guard declared. That removal is the assertion
- [x] 1.4 Confirm `src/auth/auth-seam.spec.ts` and every existing user route still pass — an unmarked
      route must stay reachable by any authenticated caller

## 2. Allocation, written test-first against the test database

- [x] 2.1 `src/credit/services/credit.service.spec.ts`: an allocation joining a caller's transaction
      commits with it, and rolls back with it leaving no row and no balance change
- [x] 2.2 Test: an allocation names its ledger — a subscription grant leaves add-on untouched, an
      add-on grant leaves subscription untouched, and the row is an `ALLOCATION` carrying the caller's
      key and its `balanceAfter`
- [x] 2.3 Test: a repeated allocation key grants nothing further, adds no row, and returns the row the
      first call wrote
- [x] 2.4 Test: two different keys for the same month both grant — the ledger enforces uniqueness, not
      meaning
- [x] 2.5 Test: an allocation carrying a Stripe invoice id and a period start records both, and one
      carrying neither still succeeds
- [x] 2.6 Test: a replacing allocation of 200 against 30 leftover lands on 200, writes a `RESET` of
      −30 with `balanceAfter` 0 and an `ALLOCATION` of 200 with `balanceAfter` 200, and leaves add-on
      alone
- [x] 2.7 Test: a retried replacing allocation does not zero the balance a second time and adds
      neither row; the `RESET` leg carries no idempotency key and the `ALLOCATION` leg carries the
      caller's
- [x] 2.8 Test: a non-replacing allocation of 200 against 30 lands on 230 and writes no `RESET`; a
      replacing allocation naming the add-on ledger is refused and writes nothing
- [x] 2.9 Extend `repositories/credit-transaction.repository.ts` — find an `ALLOCATION` by wallet,
      key and ledger; reuse the existing `create`. Extend `credit-wallet.repository.ts` only if the
      existing `lockByUserId` and `setBalances` do not cover it
- [x] 2.10 Implement `allocate(tx, …)` in `services/credit.service.ts`: lock the wallet, `404` on a
      missing one, replay on an existing key, otherwise write the `RESET` leg when replacing and then
      the `ALLOCATION`, and set the balance. The wallet lock is what makes the replay reachable — a
      `P2002` cannot be translated inside the caller's transaction, because the violation aborts it.
      No metric and no event inside the transaction

## 3. Reset, written test-first

- [x] 3.1 Test: resetting a wallet holding 120 subscription and 50 add-on credits zeroes subscription,
      leaves add-on at 50, and writes a `RESET` row of −120 with `balanceAfter` 0
- [x] 3.2 Test: resetting a wallet whose subscription ledger is already empty writes no row
- [x] 3.3 Implement `reset(tx, userId)` — lock, read, write the row only when there is something to
      forfeit, set the balance

## 4. Freeze and unfreeze, written test-first

- [x] 4.1 Test: freezing a wallet holding 50 add-on credits leaves the balance at 50 and writes no
      `CreditTransaction` row
- [x] 4.2 Test: a frozen wallet holding 0 subscription and 50 add-on credits declines a consumption of
      10 with `BILLING_FROZEN`; unfreezing returns the same 50 and consumption succeeds again
- [x] 4.3 Test: freezing a `FROZEN` wallet and unfreezing an `ACTIVE` one change neither status nor
      balances
- [x] 4.4 Test: a frozen wallet can still be allocated to, adjusted, and reset — a freeze gates
      consumption only
- [x] 4.5 Implement `freeze(tx, userId)` and `unfreeze(tx, userId)` — `WalletStatus` alone, no row, no
      balance write. Add the status write to `credit-wallet.repository.ts`

## 5. Adjustment, written test-first

- [x] 5.1 Test: a positive adjustment credits the add-on ledger only and writes an `ADJUSTMENT` row
      carrying the admin's reason; a negative one debits it only
- [x] 5.2 Test: an adjustment of −50 against 30 add-on credits raises `AdjustmentExceedsBalanceError`
      and writes nothing; −30 against 30 lands on exactly 0
- [x] 5.3 Test: no adjustment can reach the subscription ledger — the service takes no ledger argument
      and the subscription balance is unchanged in every case above
- [x] 5.4 Add `ADJUSTMENT_EXCEEDS_BALANCE` to `ERROR_CODES` in `src/common/errors/error-code.ts` and
      declare `AdjustmentExceedsBalanceError` in `src/credit/credit.errors.ts` as a `400`. It is not
      an `INSUFFICIENT_CREDITS` decline: decline reasons are a `200` response contract and stay out of
      the `ErrorCode` union
- [x] 5.5 Implement `adjust(userId, amount, reason)` — it opens its own transaction, like `consume`;
      lock, `404` on a missing wallet, refuse an over-large debit, write the `ADJUSTMENT` row against
      the add-on ledger, set the balance

## 6. Constraints asserted by violating them

- [x] 6.1 Extend `test/ledger-invariants.spec.ts`: a second `CreditTransaction` carrying an
      idempotency key and ledger already used is rejected by `@@unique([idempotencyKey, ledger])`,
      asserted for an `ALLOCATION` pair rather than only the consumption pair already covered
- [x] 6.2 Confirm the existing `CreditWallet_addonCredits_non_negative` case still asserts what the
      adjustment path relies on, and name it as the test for the negative-balance scenario

## 7. The HTTP surface

- [x] 7.1 Add `dto/adjust-credits.dto.ts` — amount a non-zero integer, reason a required non-empty
      string, and no other property, so a body naming a ledger is `400 VALIDATION_FAILED` from the
      global pipe
- [x] 7.2 Add `controllers/admin-credit.controller.ts` serving
      `POST /v1/admin/users/:userId/credits/adjust`, marked `@Roles(Role.ADMIN)` from
      `common/identity/`, reading the subject from the path and containing no business logic. Register
      it in `credit.module.ts`
- [x] 7.3 `test/credit-http.spec.ts`: an admin adjust returns the new balances; a `USER` token is
      `403 FORBIDDEN`; no token is `401 UNAUTHORIZED`; a user with no wallet is `404 NOT_FOUND`
- [x] 7.4 Test: an amount of zero or a non-integer is `400 VALIDATION_FAILED`, a body naming a ledger
      is `400 VALIDATION_FAILED`, and an over-large debit renders as `400
      ADJUSTMENT_EXCEEDS_BALANCE` in the standard error envelope
- [x] 7.5 Confirm `src/credit/credit-seam.spec.ts` still passes — the admin route must reach
      `@Roles()` through `common/identity/` and never through `src/auth/`

## 8. Docs and close out

- [x] 8.1 Amend `docs/architecture/api-surface.md`: the adjust request and response shapes, the
      `ADJUSTMENT_EXCEEDS_BALANCE` code, and that the route acts on the user in the path rather than
      on the caller
- [x] 8.2 Amend `docs/architecture/module-boundaries.md`: role enforcement is global and its marker is
      published by `common/identity/`, so a leaf module owns an admin route without an edge back to
      `auth`
- [x] 8.3 Amend `docs/requirements/billing-service-requirements.md` §6 and the Subscription Credits
      section: state that subscription credits do not roll over and that a renewal replaces the
      balance, so the sentence about resetting and the mid-cycle additive rule stop reading as a
      contradiction
- [x] 8.4 Run `npm run build`, `npm test`, and `npm run lint`; all three pass
- [x] 8.5 Confirm `prisma/schema.prisma` is unmodified, no migration was generated, and no
      configuration key was added
- [x] 8.6 Update `docs/testing/requirement-coverage.md`: move `Add-on credits survive a freeze and
      never expire`, `Allocation is idempotent on subscription and month`, and `Admin adjustments
      target add-on credits only` to `covered`, each with the name of the test that asserts it; add
      the new Section 6 row `A renewal replaces subscription credits; unused credits do not roll over`
      as `covered` with its test
- [x] 8.7 Close wayfinder ticket 022: post the answer, mark it closed, and add its one-line gist to
      the map's Decisions-so-far — including the no-rollover rule, which the requirements did not
      settle on their own
