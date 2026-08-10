## 1. Configuration and storage

- [x] 1.1 Add the signing-secret list to `stripeConfig` and `AppConfigService`, with `.env.example`
- [x] 1.2 Add `webhook.constants.ts` (event type strings) and `webhook-event.repository.ts` (record, find by Stripe id, mark outcome)

## 2. Ingestion and dispatch

- [x] 2.1 Add the handler outcome type and `handlers/` with the registry and one trivial handler proving the path
- [x] 2.2 Add `webhook.controller.ts` — verify, commit the row, then process in its own transaction
- [x] 2.3 Implement redelivery by recorded status, skipping `COMPLETED` and reprocessing anything else
- [x] 2.4 Create `webhook.module.ts` and register it in `src/app.module.ts`
- [x] 2.5 Test signature rejection, the duplicate constraint, redelivery of a failed event, deferral versus failure, and dispatch including an unsubscribed type

## 3. Close out

- [x] 3.1 Verify `stripe listen --forward-to` by hand and record the result in ticket 002
- [x] 3.2 Run `npm run build`, `npm test`, `npm run lint`; confirm `prisma/schema.prisma` is unmodified
- [x] 3.3 Update `requirement-coverage.md` with the test names, and close ticket 024
  