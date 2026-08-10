## Context

Ticket 028 closes the business rules: which rows are due, one transaction per month, anchored month
arithmetic, and no claim lease. They are not restated here — read
`docs/wayfinder/tickets/028-build-annual-allocation-cron.md`. What is left open is where the internal
key machinery can physically live, which this change is the first to need.

## Goals / Non-Goals

**Goals:**

- A routine that grants due months and is safe to invoke twice, from a schedule or over HTTP.
- An internal key that authenticates a caller carrying no user identity, reusable by later tickets.

**Non-Goals:**

- Add-on purchase (032) and the `/v1/me` surface (031). No route here belongs to a user.
- A claim lease. Ticket 028 settles why this routine needs none.

## Decisions

**`InternalKeyGuard` and `ServicePrincipal` live in `common/identity/`, not in `auth/`.**
`AuthModule` imports `BillingModule` (`src/auth/auth.module.ts`), so a billing controller importing a
guard from `auth/` would close a dependency cycle. This is the same constraint ticket 021 hit when it
moved the identity contract to `common/identity/`, and `RolesGuard` and `AuthenticatedUser` already
sit there for it. The guard reads `INTERNAL_API_KEY` through `AppConfigService` like every other
environment value.

**One composed `@InternalOnly()` decorator, not `@Public()` and `@UseGuards()` applied separately.**
The global `JwtAuthGuard` demands a bearer token on every route, so an internal route must be marked
public to reach its own guard — and a route marked public that then loses its `@UseGuards` line is
open to the internet with no error anywhere. Composing both into one decorator makes the unsafe half
unreachable on its own.

**The service principal is a separate request property.** `InternalKeyGuard` sets `request.service`;
`request.user` stays untouched, so `@CurrentUser()` resolves to nothing on an internal route and
there is no expression there that yields a user id. `AuthenticatedUser` and `RolesGuard` are
unchanged, and `ServicePrincipal` carries no identifier field to populate.

**The key is compared as a fixed-width digest, not with a raw `timingSafeEqual`.**
`crypto.timingSafeEqual` throws when the two buffers differ in length, which turns a wrong-length key
into a 500 and leaks the expected length through the status code. Hashing both sides to a SHA-256
digest first makes every comparison the same width.

**The routine batches rows, then loops months within a row.** One query selects annual subscriptions
whose `nextCreditAt` is due, over the existing `@@index([status, nextCreditAt])`; each row then grants
and advances one month at a time until `nextCreditAt >= paidThroughAt`. The grant and the advance
share a transaction so a row can never be paid for a month it is not advanced past.

**The advance is a plain write, not a compare-and-set.** Two concurrent runs read the same
`nextCreditAt` and the same anchor, so they compute the identical next value; a lost update writes the
value that was already there. The duplicate grant is refused by the month key under the wallet lock,
which is where the guarantee already lives.

**Both routes sit on one `InternalController` in `billing/controllers/`.** They trigger two billing
routines and share one guard; splitting them by routine would duplicate the wiring to say nothing new.

**Each route declares an empty request DTO rather than no body parameter.** The global pipe runs
`forbidNonWhitelisted`, so an empty DTO turns `{ "userId": … }` into a 400; a route with no `@Body()`
would accept the same payload, ignore it, and answer 200. "Rejects act-on-behalf semantics" is only
assertable in the first shape.

## Risks / Trade-offs

**A route marked `@Public()` whose guard is dropped is silently unauthenticated** → the composed
decorator above, plus a test that an unauthenticated and a wrong-key call are both refused.

**A subscription untouched for a long time loops many months in one run** → bounded by
`paidThroughAt`, so an annual term is at most twelve iterations and a term already past its boundary
is zero. Batch size bounds rows; the boundary bounds months.

**The count in the response is not a transaction boundary** → it reports what the run completed, so a
run that dies mid-catch-up returns nothing rather than a partial count. The rows are the record; the
count is a convenience for a hand-run.

**No schema change.** `nextCreditAt`, `paidThroughAt` and `@@index([status, nextCreditAt])` all
shipped with ticket 007, so no migration is generated for this change.
