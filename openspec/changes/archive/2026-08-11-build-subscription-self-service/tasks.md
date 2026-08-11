## 1. Schema and lifecycle

- [x] 1.1 Add `pendingPlanId` and `pendingCycle` to `Subscription` in `prisma/schema.prisma`, generating the migration with `migrate diff` and applying it with `migrate deploy`.
- [x] 1.2 Test first: add the `resume` edge `CANCELED → ACTIVE` to `src/billing/services/subscription-transitions.ts`.
- [x] 1.3 Test first: supersede the current subscription when a `PENDING` one activates, resetting the ledger before the new allocation, in `src/billing/services/subscription-lifecycle.service.ts`.

## 2. The held downgrade

- [x] 2.1 Test first: apply and clear the pending change before credits are granted, in `src/billing/webhook/handlers/invoice-paid.handler.ts`.
- [x] 2.2 Test first: leave `planId` alone while the retrieved price is the pending plan, in `src/billing/webhook/services/subscription-sync.service.ts`.
- [x] 2.3 Exclude rows holding a pending change from `findMispriced` in `src/billing/repositories/subscription.repository.ts`.

## 3. The subscription surface

- [x] 3.1 Read the caller's subscription from the database alone in `src/billing/services/me-subscription.service.ts`.
- [x] 3.2 Subscribe: provision defensively, write the `PENDING` row, create the Stripe subscription, in the same service.
- [x] 3.3 Change plan or cycle — upgrade with `create_prorations`, downgrade held — in the same service.
- [x] 3.4 Cancel at period end and resume, adding `cancelAtPeriodEnd` to `UpdateSubscriptionParams` and both adapters under `src/billing/stripe/`.
- [x] 3.5 Serve `GET /v1/me/wallet` from `src/credit/controllers/me-wallet.controller.ts`.

## 4. Payment methods

- [x] 4.1 Add `src/billing/repositories/payment-method.repository.ts` and `src/billing/services/payment-method.service.ts`, refusing the last card while a paid subscription runs.
- [x] 4.2 Add the `payment_method.attached` and `.detached` handlers under `src/billing/webhook/handlers/`.

## 5. Routes and coverage

- [x] 5.1 Add the `/v1/me/subscription` and `/v1/me/payment-methods` controllers and DTOs under `src/billing/controllers/` and `src/billing/dto/`.
- [x] 5.2 Move the eight claimed clauses to `covered` in `docs/testing/requirement-coverage.md`, adding the seven rows that do not exist yet.
