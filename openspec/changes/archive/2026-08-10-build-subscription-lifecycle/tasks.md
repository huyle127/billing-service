## 1. The transition table

- [x] 1.1 Add `src/billing/services/subscription-transitions.ts` — the pure `(from, event)` table with the `SubscriptionEventType` each edge records and `unchanged` for every pair it does not carry — with `subscription-transitions.spec.ts` driving the whole table in one test

## 2. The allocation owner

- [x] 2.1 Add `src/billing/services/subscription-allocation.service.ts` owning the month-keyed subscription grant, the only caller of `credit.allocate` for the `SUBSCRIPTION` ledger
- [x] 2.2 Refactor `src/billing/services/entitlement.service.ts` onto it, with a test asserting registration still grants exactly once under the same key
- [x] 2.3 Add the transition reasons to `src/billing/billing.constants.ts`

## 3. The lifecycle service

- [x] 3.1 Extend `src/billing/repositories/subscription.repository.ts` with the status write and the `SubscriptionEvent` append, both taking the caller's transaction client
- [x] 3.2 Add `src/billing/services/subscription-lifecycle.service.ts` applying a transition and writing status, `stripeStatus` and the event in one transaction, with a test that an unrepresentable transition writes neither
- [x] 3.3 Implement cancel, with a test asserting the row stays current and its credit balance is untouched
- [x] 3.4 Implement past-due and resolution calling `credit.freeze` and `credit.unfreeze` in the same transaction, with a test asserting neither writes an `ALLOCATION`
- [x] 3.5 Implement expire — `RESET` the subscription ledger, mark `EXPIRED`, then create the Free row — with a test asserting the partial unique index rejects the reverse write order

## 4. Wiring and close out

- [x] 4.1 Register the new services in `src/billing/billing.module.ts`
- [x] 4.2 Run `npm run build`, `npm test` and `npm run lint`, and confirm `prisma/schema.prisma` is unmodified
- [x] 4.3 Remove the taken-over clause from `docs/wayfinder/tickets/027-build-invoice-handlers-and-allocation.md`
- [x] 4.4 Close ticket 025 and add its line to `docs/wayfinder/map-billing-service-build.md`
- [x] 4.5 Update `docs/testing/requirement-coverage.md`, moving each claimed clause from `todo` to `covered` with the name of the test that asserts it
    