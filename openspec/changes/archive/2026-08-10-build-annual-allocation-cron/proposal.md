## Why

Annual subscriptions pay once upfront and earn credits monthly, and nothing grants those months.
`build-webhook-invoice-handlers` dates `nextCreditAt` on annual rows, so the rows exist and nothing
reads them. **028** (`docs/wayfinder/tickets/028-build-annual-allocation-cron.md`).

## What Changes

- **One idempotent routine, two triggers** — an in-process interval and
  `POST /v1/internal/allocations/run`. Running both at once grants nothing twice, asserted rather
  than prevented by serialising them.
- **Due rows are `ACTIVE`, plus `CANCELED` still inside `paidThroughAt`** — an annual term is paid
  upfront, so cancelling mid-year forfeits no month already bought.
- **Catch-up is one month per transaction.** Each missed month is its own `CreditTransaction` under
  its own month key; a run that dies half way keeps what it granted and resumes where it stopped.
- **The boundary is `nextCreditAt < paidThroughAt`**, both rows we own, so the routine reaches no
  network. Month arithmetic is `credit-schedule.ts`, already shipped — no key and no date maths here.
- **`POST /v1/internal/provisioning/run`** invokes the same `ProvisioningService.sweep()` the
  schedule invokes, giving `InternalKeyGuard` a second real caller. Both routes answer a count.
- **`InternalKeyGuard` sets `request.service`, never `request.user`**, so `@CurrentUser()` resolves
  to nothing on an internal route and no expression there yields a user id.
  **Not shipped:** no claim lease — the wallet lock and the month key already serialise concurrent
  runs, and this routine holds no network call across one.

## Capabilities

### New Capabilities

- `annual-allocation`: which subscriptions are due, how many months they earn, where they stop.

### Modified Capabilities

- `authentication`: the internal API key yields a service principal carrying no user identity.
- `subscription-provisioning`: the sweep gains a second trigger behind that key.

## Impact

**Clauses off `todo`**, verbatim — §3: `Cron allocates monthly for annual subscriptions`, `Cron
catches up one month at a time across missed periods`, `Cron never allocates past the paid-through
boundary`; §9: `Internal key yields a service principal with no user identity`, `Internal endpoints
reject "act on behalf of" semantics`. **6 new tests**, under the ceiling. **No schema change.**
