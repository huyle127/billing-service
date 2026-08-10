## 1. The internal key seam

- [x] 1.1 Add `ServicePrincipal` and `RequestWithService` in `src/common/identity/service-principal.ts`, with no field able to hold a user id
- [x] 1.2 Build `InternalKeyGuard` in `src/common/identity/internal-key.guard.ts`, comparing SHA-256 digests of the presented and configured keys
- [x] 1.3 Compose `@InternalOnly()` in `src/common/identity/internal-only.decorator.ts` from `@Public()` and `UseGuards(InternalKeyGuard)`

## 2. The allocation routine

- [x] 2.1 Add `findDueForCredit` and `advanceNextCreditAt` to `src/billing/repositories/subscription.repository.ts` for annual rows that are `ACTIVE`, or `CANCELED` inside `paidThroughAt`
- [x] 2.2 Build `AnnualAllocationService` in `src/billing/services/annual-allocation.service.ts`, test-first, granting and advancing one month per transaction until the boundary

## 3. The triggers

- [x] 3.1 Move the unread `CREDIT_ALLOCATION_CRON` into an `allocation` namespace and add `CREDIT_ALLOCATION_BATCH_SIZE` in `src/common/config/configuration.ts` and `src/common/config/app-config.service.ts`
- [x] 3.2 Build `AnnualAllocationSchedulerService` in `src/billing/services/annual-allocation-scheduler.service.ts` on `allocation.cron`, mirroring `ProvisioningSchedulerService`
- [x] 3.3 Add the empty `RunRequestDto` in `src/billing/dto/run-request.dto.ts` so a body naming a user is refused by the global pipe
- [x] 3.4 Build `InternalController` in `src/billing/controllers/internal.controller.ts` with both routes behind `@InternalOnly()`, asserted in `test/internal-endpoints.spec.ts`
- [x] 3.5 Register the controller, the service, its scheduler and `InternalKeyGuard` in `src/billing/billing.module.ts`

## 4. Close the loop

- [x] 4.1 Move the three §3 cron clauses and the two §9 internal clauses to `covered` in `docs/testing/requirement-coverage.md`, naming the test that asserts each
