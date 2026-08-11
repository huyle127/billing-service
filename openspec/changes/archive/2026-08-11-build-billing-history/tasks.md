## 1. The merged read

- [x] 1.1 Add `src/billing/services/history-cursor.ts` encoding `(occurredAt, source, id)` opaquely, with `history-cursor.spec.ts` asserting the round trip and the tie order across three sources.
- [x] 1.2 Add a cursor-bounded, `from`-bounded listing to `src/credit/repositories/credit-transaction.repository.ts`.
- [x] 1.3 Add `history(userId, window)` to `src/credit/services/credit.service.ts`, projecting rows with `createdAt` as `occurredAt`.
- [x] 1.4 Add `src/billing/repositories/subscription-event.repository.ts` listing a user's events across every subscription they have held.
- [x] 1.5 Add the same listing at every payment status to `src/billing/repositories/payment-transaction.repository.ts`.
- [x] 1.6 Add `src/billing/services/history.service.ts` merging the three sources at `limit + 1` each and returning the page with its next cursor.

## 2. The routes

- [x] 2.1 Add `src/billing/dto/history-query.dto.ts` with `type`, `from`, `limit`, and `cursor`, refusing a source name outside the three.
- [x] 2.2 Add `src/billing/controllers/me-history.controller.ts` serving `GET /v1/me/history`.
- [x] 2.3 Embed the first page and its cursor in `src/billing/services/admin-billing-view.service.ts`, taking `cursor` on `src/billing/controllers/admin-billing.controller.ts`.
- [x] 2.4 Declare the source names and the admin page limit in `src/billing/billing.constants.ts`.
- [x] 2.5 Register the controller, the service, and the repository in `src/billing/billing.module.ts`.

## 3. Assertions

- [x] 3.1 Add `test/history-http.spec.ts` asserting that paging one row at a time across three rows sharing one timestamp returns each exactly once, and that a row written at the head after the first page leaves the second page free of repeats.
- [x] 3.2 Extend `test/history-http.spec.ts` with `?type=credit` returning only credit rows, and with a page carrying a pending, a failed, and a succeeded payment each at its own status.

## 4. Coverage

- [x] 4.1 Add Section 8 to `docs/testing/requirement-coverage.md` and move the three clauses the proposal claims to `covered`, naming the test that asserts each.
