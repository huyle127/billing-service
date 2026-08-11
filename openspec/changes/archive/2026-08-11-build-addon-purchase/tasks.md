## 1. Schema and repositories

- [x] 1.1 Add `addonPackageId` and a unique `stripePaymentIntentId` to `PaymentTransaction` in `prisma/schema.prisma`, generating the migration with `migrate diff` and applying it with `migrate deploy`.
- [x] 1.2 Extend `src/billing/repositories/payment-transaction.repository.ts` with opening a `PENDING` add-on purchase, loading one with its package, and settling it.
- [x] 1.3 Add a default-card lookup to `src/billing/repositories/payment-method.repository.ts`.

## 2. The grant

- [x] 2.1 Add `retrieveOneTimePayment` to `src/billing/stripe/interfaces/stripe-adapter.interface.ts` and both adapters, so handlers read the intent Stripe holds rather than the payload.
- [x] 2.2 Add `src/billing/webhook/services/purchase-resolution.service.ts`, resolving the intent's `purchaseId` metadata to a local purchase and deferring when it names none.
- [x] 2.3 Test first: grant the `ADDON` allocation and settle the payment row in one transaction keyed on the purchase, in `src/billing/webhook/handlers/payment-intent-succeeded.handler.ts`.
- [x] 2.4 Test first: mark the purchase `FAILED` and grant nothing, in `src/billing/webhook/handlers/payment-intent-payment-failed.handler.ts`.
- [x] 2.5 Declare both event types and the new deferral reason in `src/billing/webhook/webhook.constants.ts`, registering the handlers in `src/billing/webhook/webhook.module.ts`.

## 3. The purchase flow

- [x] 3.1 Add `src/billing/services/addon-purchase.service.ts`: refuse a frozen wallet and a cardless caller, provision, write the `PENDING` row, then create the intent.
- [x] 3.2 Declare the allocation reason and the refusal messages in `src/billing/billing.constants.ts` and `src/billing/billing.errors.ts`.
- [x] 3.3 Add `src/billing/controllers/me-addon.controller.ts` and `src/billing/dto/purchase-addon.dto.ts`, wiring both into `src/billing/billing.module.ts`.
- [x] 3.4 Test first: assert in `test/addon-purchase.spec.ts` that a purchase grants nothing on its own, that a frozen wallet is refused before Stripe is called, and that two purchases of one package both land.

## 4. Coverage

- [x] 4.1 Add Section 7 to `docs/testing/requirement-coverage.md` and move every clause the proposal claims to `covered`, naming the test that asserts it.
