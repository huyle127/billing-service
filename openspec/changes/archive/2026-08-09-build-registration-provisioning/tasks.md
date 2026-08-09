## 1. Configuration and module scaffolding, first because everything below reads them

- [x] 1.1 Add `provisioningConfig` to `src/common/config/configuration.ts` following the shape
      `webhookConfig` uses — `sweepIntervalMs` (`PROVISIONING_SWEEP_INTERVAL_MS`, default 60000),
      `batchSize` (`PROVISIONING_BATCH_SIZE`, 50), `retryBackoffMs` (`PROVISIONING_RETRY_BACKOFF_MS`,
      60000), `staleAfterMs` (`PROVISIONING_STALE_AFTER_MS`, 3600000). Register it in `configurations`
- [x] 1.2 Expose the four values through `AppConfigService` and add them to `.env.example` with the
      defaults and a line saying a sweep interval of zero disables the schedule
- [x] 1.3 Extend `src/common/config/configuration.spec.ts` only where it can silently break: a
      non-integer or negative value is refused at boot, and zero is accepted for the interval rather
      than falling back to the default
- [x] 1.4 Create `src/billing/billing.constants.ts` with `FREE_PLAN` (`code` and `cycle`),
      `ALLOCATION_KEYS.month(subscriptionId, at)` yielding `sub:{id}:{YYYY-MM}` in UTC, and
      `ALLOCATION_REASONS.registration`. Nothing here may be a literal at a call site — ticket 027 and
      028 must build the same key string from this function
- [x] 1.5 Unit-test `ALLOCATION_KEYS.month`: two instants in the same UTC month give the same string,
      the last instant of a month and the first of the next give different ones. This is the function
      the double-grant defence rests on

## 2. Wallet creation in the ledger, written test-first

- [x] 2.1 `src/credit/services/credit.service.spec.ts`: a wallet created inside a caller's transaction
      commits with it holding zero on both ledgers and status `ACTIVE`, and rolls back with it leaving
      no row
- [x] 2.2 Test: a wallet created and allocated to within one transaction commits holding the allocated
      amount and its `ALLOCATION` row
- [x] 2.3 Extend `test/ledger-invariants.spec.ts`: a second `CreditWallet` for a user who already
      holds one is rejected by the `@unique` on `CreditWallet.userId`, asserted by attempting the
      violation
- [x] 2.4 Add `createWallet(tx, userId)` to `CreditWalletRepository` and expose it on `CreditService`.
      No status argument and no balance argument — a wallet opens empty and active or the caller is
      doing something the ledger has no name for

## 3. The registration transaction, written test-first

- [x] 3.1 `src/billing/services/entitlement.service.spec.ts`: granting on registration creates the
      `BillingCustomer` with a null `stripeCustomerId`, an `ACTIVE` Free `Subscription` with a null
      `stripeSubscriptionId`, the wallet, and an `ALLOCATION` of the Free plan's `monthlyCredits`
- [x] 3.2 Test: the grant carries this month's allocation key, and a second allocation under the same
      key writes nothing and leaves the balance alone — the ticket 014 near-miss, asserted here rather
      than guarded in code
- [x] 3.3 Test: with no active Free plan in the catalog the grant fails and writes nothing
- [x] 3.4 Add `src/billing/repositories/plan.repository.ts` (find the active plan by code and cycle),
      `billing-customer.repository.ts` (create in a transaction, find by user) and
      `subscription.repository.ts` (create the Free row in a transaction)
- [x] 3.5 Implement `src/billing/services/entitlement.service.ts` — `grantOnRegistration(tx, user)`
      writing the four rows in the caller's transaction with the field values the design table fixes,
      and no Stripe call of any kind
- [x] 3.6 Create `src/billing/billing.module.ts` importing `PrismaModule`, `StripeModule`,
      `ClockModule` and `CreditModule`, exporting the services `auth` will call; register it in
      `src/app.module.ts` and import it from `auth.module.ts`
- [x] 3.7 Extend `AuthService.register` to call `grantOnRegistration` inside the existing transaction,
      with `LEDGER_TRANSACTION`'s timeouts now that it locks a wallet
- [x] 3.8 `src/auth/services/auth.service.spec.ts`: registration commits user, credential, customer,
      subscription, wallet and allocation together, and a failure part-way leaves none of them
- [x] 3.9 Test: registration succeeds with every Stripe operation set to fail through the fake's
      `failNext`, leaving both Stripe identifiers null. This is the clause that says entitlement does
      not depend on Stripe
- [x] 3.10 Confirm `src/auth/auth-seam.spec.ts` and `src/credit/credit-seam.spec.ts` still pass —
      `auth` reaches `credit` only through `billing`, and `credit` imports neither

## 4. The provisioning routine, written test-first

- [x] 4.1 `src/billing/services/provisioning.service.spec.ts`: provisioning a pending user attaches
      `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId` and `stripeStatus`, and leaves
      `syncAttempts` at zero with `syncError` null on both rows
- [x] 4.2 Test: running it a second time changes no identifier and creates no second Stripe object,
      asserted through the fake's `customerCount` and `subscriptionCount`
- [x] 4.3 Test: with the Stripe object already created but the local write missing, and the fake's
      `expireIdempotencyKeys()` called, provisioning adopts the existing object by metadata rather
      than creating a second — once for the customer, once for the subscription. This is the layer
      that covers Stripe's 24-hour key expiry and it is the reason the metadata search exists
- [x] 4.4 Test: a failing Stripe call leaves the identifier null, increments `syncAttempts`, records
      `syncError`, and pushes `syncNextAttemptAt` forward; a second failure pushes it further than the
      first; a later success clears both fields
- [x] 4.5 Test: two concurrent provisioning runs for one user persist exactly one `stripeCustomerId`
      and leave exactly one Stripe Customer — the unique constraint decides, and the loser's retry
      finds the work done
- [x] 4.6 Extend `billing-customer.repository.ts` and `subscription.repository.ts` with attach and
      record-failure methods
- [x] 4.7 Implement `src/billing/services/provisioning.service.ts` — `provision(userId)` as
      customer-then-subscription, each step retrieve-then-search-then-create, persisting after each
      Stripe call and never inside a transaction that spans one

## 5. The sweep, written test-first

- [x] 5.1 Test: a sweep provisions every outstanding pending subscription and leaves a row whose
      `syncNextAttemptAt` is in the future untouched
- [x] 5.2 Test: an `EXPIRED` subscription carrying no `stripeSubscriptionId` is never picked up — the
      predicate must match `Subscription_pending_sync`, and history is not a backlog
- [x] 5.3 Test: with a backlog larger than the configured batch size, one sweep provisions at most
      that many rows and the rest stay pending
- [x] 5.4 Test: two sweeps running concurrently provision each row once, asserted on
      `subscriptionCount` rather than on timing
- [x] 5.5 Add the claim query to `subscription.repository.ts` — `SELECT … FOR UPDATE SKIP LOCKED`
      over the pending predicate ordered by `syncNextAttemptAt`, then the backoff write, both in one
      short transaction that returns before any Stripe call. Every identifier double-quoted
- [x] 5.6 Implement `sweep()` on `ProvisioningService` — claim a batch, commit, then provision each
      claimed row outside any transaction
- [x] 5.7 Log at error level each claimed row older than `staleAfterMs`, naming the subscription id,
      the attempt count and `syncError`, and keep attempting it. Age, not attempt count

## 6. The schedule

- [x] 6.1 Implement `src/billing/services/provisioning-scheduler.service.ts` — `OnModuleInit` adding
      the interval through `SchedulerRegistry` at `sweepIntervalMs`, and registering nothing at all
      when that value is zero
- [x] 6.2 Test: a zero interval registers no interval, and a non-zero one registers exactly one whose
      callback reaches the same `sweep()` the direct call reaches
- [x] 6.3 Confirm the default test environment leaves the sweep disabled, so no test asserting on
      pending rows can be swept out from under itself

## 7. End to end through HTTP

- [x] 7.1 `test/auth-http.spec.ts`: `POST /v1/auth/register` returns the user, and the committed rows
      show plan and balance immediately — the dashboard claim, asserted at the boundary that serves it
- [x] 7.2 Test: a registered user's token can immediately consume credits against the registration
      grant, and a duplicate email is still `400 VALIDATION_FAILED` with nothing written
- [x] 7.3 Do not assert the Stripe objects from the HTTP test. Provisioning is not awaited, so the
      assertion would race the response; `provisioning.service.spec.ts` owns it

## 8. Docs and close out

- [x] 8.1 Amend `docs/architecture/module-boundaries.md`: `billing/` now has `services/` and
      `repositories/`, and record that a scheduler is a service under `services/` rather than a role
      of its own
- [x] 8.2 Amend `docs/architecture/api-surface.md`: the Internal endpoints table notes that both
      routes arrive with ticket 028, so the section does not read as describing something that exists
- [x] 8.3 Amend `docs/wayfinder/tickets/028-build-annual-allocation-cron.md`: it now also ships
      `POST /v1/internal/provisioning/run`, `InternalKeyGuard` and the service principal, and closes
      the two Section 9 clauses. Note the handover in ticket 023's answer as well
- [x] 8.4 Run `npm run build`, `npm test` and `npm run lint`; all three pass
- [x] 8.5 Confirm `prisma/schema.prisma` is unmodified and no migration was generated
- [x] 8.6 Update `docs/testing/requirement-coverage.md`: move `Registration grants plan and credits
      without contacting Stripe`, `Stripe customer and subscription provisioned immediately after
      registration` and `A subscription with no Stripe id is a valid intermediate state` to `covered`,
      each with the name of the test that asserts it; re-point the two Section 9 internal clauses to
      `todo — ticket 028` and rewrite the note beneath the table to say why the deferral moved
- [x] 8.7 Close wayfinder ticket 023: post the answer, mark it closed, and add its gist to the map's
      Decisions-so-far — the claim-then-work sweep, the two-service split, and the internal endpoint
      moving to 028 under ticket 020's own rule
