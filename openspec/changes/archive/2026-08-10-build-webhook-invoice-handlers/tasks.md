## 1. The seam and the table

- [x] 1.1 Add `billingReason` and `periodStart` to `StripeInvoice` and map them in both adapters
- [x] 1.2 Add `PENDING + renew → ACTIVE` recording `CREATED` to `src/billing/services/subscription-transitions.ts` and its expected table in the existing spec

## 2. Reading an invoice

- [x] 2.1 Add `src/billing/webhook/services/invoice-reading.service.ts` — paid, grant owed, the period, and the amount — as the one place the money rules live
- [x] 2.2 Add `src/billing/repositories/payment-transaction.repository.ts` upserting on `stripeInvoiceId`, and the `paidThroughAt` / `nextCreditAt` write to `subscription.repository.ts`

## 3. The handlers

- [x] 3.1 Add `invoice-paid.handler.ts` — renew, grant through the allocation owner keyed on `period_start`, boundary writes, payment record — with tests that `manual` grants nothing while `subscription_cycle` grants, that a redelivery in a later month grants once, and that a zero-amount invoice grants credits but writes no payment record
- [x] 3.2 Add `invoice-payment-failed.handler.ts` driving the past-due transition, with a test that a failed-then-paid invoice leaves one `SUCCEEDED` `PaymentTransaction` and a thawed wallet
- [x] 3.3 Add the two event types to `webhook.constants.ts` and register both handlers
- [x] 3.4 Add a test that an annual paid invoice sets `paidThroughAt` and `nextCreditAt` while a monthly one leaves `nextCreditAt` unset

## 4. Close out

- [x] 4.1 Extend the convergence test in `test/webhook-subscriptions.spec.ts` to interleave invoice events with the subscription history
- [x] 4.2 Run `npm run build`, `npm test`, `npm run lint`, and confirm `prisma/schema.prisma` is unmodified
- [x] 4.3 Move the five Section 6 clauses and the Section 5 convergence clause to `covered` in `docs/testing/requirement-coverage.md`, naming the test for each
- [x] 4.4 Close ticket 026 and update its line and the Frontier in `docs/wayfinder/map-billing-service-build.md`
