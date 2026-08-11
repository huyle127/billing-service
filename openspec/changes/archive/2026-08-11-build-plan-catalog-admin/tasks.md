## 1. The Stripe seam

- [x] 1.1 Add nullable `stripeProductId` to `Plan` and `AddonPackage` in `prisma/schema.prisma`, shipped with `migrate diff` and `migrate deploy`
- [x] 1.2 Widen `IDEMPOTENCY_KEYS.price` with the interval and add `findPricesByPlanCode` to `src/billing/stripe/stripe.constants.ts`, the interface, the SDK adapter over `prices.search`, and the fake

## 2. The catalog

- [x] 2.1 Extend `src/billing/repositories/plan.repository.ts` and add `src/billing/repositories/addon-package.repository.ts` with list, create, reprice and archive
- [x] 2.2 Add `PLAN_IN_USE` to `src/common/errors/error-code.ts`, `PlanInUseException` in `src/billing/billing.errors.ts`, and `countActiveByPlanId` to `src/billing/repositories/subscription.repository.ts`
- [x] 2.3 Build `CatalogService` in `src/billing/services/catalog.service.ts` — Stripe before the database, reprice mints and archives, archive refuses while in use — with its tests
- [x] 2.4 Add the create and update DTOs for plans and packages under `src/billing/dto/`
- [x] 2.5 Build `CatalogController` and `AdminCatalogController` in `src/billing/controllers/`, the second behind `@Roles(Role.ADMIN)`, asserted in `test/catalog-http.spec.ts`

## 3. The migration reconciler

- [x] 3.1 Add `findMispriced` to `src/billing/repositories/subscription.repository.ts` over `@@index([status, planId, stripePriceId])`
- [x] 3.2 Build `CatalogReconcilerService` in `src/billing/services/catalog-reconciler.service.ts`, test-first, migrating at `prorationBehavior: 'none'` and recording the new Price on the row
- [x] 3.3 Add the orphan Price report to the same service, searching per distinct local plan code
- [x] 3.4 Add `catalog.cron` and `catalog.batchSize` in `src/common/config/configuration.ts` and `src/common/config/app-config.service.ts`
- [x] 3.5 Add `CATALOG_MIGRATION_SWEEP` to `src/billing/billing.constants.ts` and build `CatalogReconcilerSchedulerService` mirroring `AnnualAllocationSchedulerService`

## 4. The admin view and the wiring

- [x] 4.1 Build `AdminBillingController` in `src/billing/controllers/admin-billing.controller.ts` answering `GET /v1/admin/users/:userId/billing` from local rows
- [x] 4.2 Register the controllers, services, repositories and scheduler in `src/billing/billing.module.ts`

## 5. Close the loop

- [x] 5.1 Document `PLAN_IN_USE` in `docs/architecture/api-surface.md`, then move the seven §4 catalog clauses to `covered` in `docs/testing/requirement-coverage.md`, naming the test that asserts each
