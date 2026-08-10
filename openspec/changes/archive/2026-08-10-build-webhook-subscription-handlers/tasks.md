## 1. The lifecycle edge and the marker

- [x] 1.1 Unfreeze on every edge leaving `PAST_DUE` in `src/billing/services/subscription-lifecycle.service.ts`, with a test that a past due subscription expiring leaves the wallet `ACTIVE` and the Free grant spendable
- [x] 1.2 Add `stripePeriodEnd` to `Subscription` in `prisma/schema.prisma`, migration generated with `migrate diff` and applied with `migrate deploy`

## 2. The handler contract

- [x] 2.1 Reduce `WebhookHandler` to `resolve(event)`, returning a resolution that carries its own `apply(tx)`, in `src/billing/webhook/handlers/webhook-handler.interface.ts`
- [x] 2.2 Call `resolve` before opening the transaction in `src/billing/webhook/services/webhook.service.ts`, returning a deferral without opening one
- [x] 2.3 Add the four handled event types to `src/billing/webhook/webhook.constants.ts`

## 3. Matching, guarding, and the writes they need

- [x] 3.1 Add `src/billing/webhook/services/subscription-sync.service.ts` — match on `metadata.subscriptionId`, the `stripePeriodEnd` guard, and the `planId` re-point from the retrieved price
- [x] 3.2 Add the lookup by local id, the Stripe field write, and the customer attach to `src/billing/repositories/subscription.repository.ts` and `billing-customer.repository.ts`

## 4. The handlers

- [x] 4.1 Add `subscription-created.handler.ts` — attach or defer — with tests that an unmatched event defers leaving the `Subscription` count unchanged, and that a redelivery attaches once
- [x] 4.2 Add `subscription-updated.handler.ts` — sync, re-point, cancel — with tests that Stripe's price beats a stale payload writing no `ALLOCATION`, that a superseded period end changes nothing, and that `cancel_at_period_end` reaches `CANCELED` while staying current
- [x] 4.3 Add `subscription-deleted.handler.ts` driving `expire`, with a test that credits are forfeited and a Free subscription replaces the row
- [x] 4.4 Add `customer-created.handler.ts` attaching `stripeCustomerId` or deferring
- [x] 4.5 Register the four handlers in `webhook-handler.registry.ts` and delete `subscription-trial-will-end.handler.ts`

## 5. Convergence and the record

- [x] 5.1 Add `test/webhook-subscriptions.spec.ts`, ending with a replay of the subscription history shuffled with duplicates against an ordered run on a second user, asserting identical rows
- [x] 5.2 Set the Stripe account's post-retry behaviour to `Cancel subscription` and record it in `docs/wayfinder/tickets/002-provision-stripe-test-account.md`
- [x] 5.3 Move the five Section 5 clauses from `todo` to `covered` in `docs/testing/requirement-coverage.md`, naming the test that asserts each
