# 020 Build the auth module

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-05) -->
<!-- assignee: -->
<!-- output: src/auth/, src/user/ -->
<!-- blocked-by: 018 -->

## Question

Build the credential store, token issuance, and the guards that produce a verified principal.
Designed in [009](009-design-auth-module.md); this is the execution.

- `src/auth/` owns `AuthCredential` and nothing else. `src/user/` owns `User`. **Nothing outside
  `auth` reads `AuthCredential`** — that is the whole point of the split, because this module is
  built to be deleted when an upstream Authentication Service arrives, and `User` is what billing
  holds foreign keys against.
- Registration here creates `User` and `AuthCredential` in one transaction. **The billing side of
  registration — Free Subscription, Credit Wallet, the first credit grant — is ticket 023**, which
  extends this same transaction. Do not build it here and do not leave a seam that makes joining it
  awkward.
- **Three jobs, three algorithms**, recorded because confusing them is a real vulnerability:
  **bcrypt** for passwords (human-chosen, therefore guessable), **SHA-256** for the stored refresh
  token hash (a high-entropy machine-generated value with no dictionary to attack, so bcrypt's
  deliberate cost would buy nothing and be paid on every refresh), **HS256** for signing.
- Claims are limited to subject, role, and expiry. Issuer and audience are deliberately omitted —
  with a single service they would validate nothing. OAuth and asymmetric keys are out of scope.
- Logout revokes by clearing the stored refresh hash.
- **Guards produce a `Principal`.** A user principal carries `userId` and `role`. **The internal API
  key yields a service principal with no user identity at all** — make that unrepresentable in the
  type rather than merely rejected at runtime, so an internal endpoint cannot express "act on behalf
  of user X". Were the internal key able to assume a user identity, one leaked environment variable
  would grant access to every account.
- Roles guard for `USER` / `ADMIN`.
- The Stripe webhook route bypasses all of this and authenticates by signature instead.

**The first ADMIN — settled 2026-08-05.** Nothing in the design said how one comes to exist:
`User.role` defaults to `USER`, and every admin route needs an admin token. **`prisma/seed.ts`
creates it from `ADMIN_EMAIL` and `ADMIN_PASSWORD`**, idempotently, skipping if a user with that
email already exists. The seed script already runs against both the development and `billing_test`
databases, so admin-route tests get their principal from the same path production does. Rejected:
promoting the first registered user, which turns registration into a privilege-escalation race.
There is no runtime route that grants `ADMIN` — role changes are a database operation only.

**Replaceability check, run as part of this ticket:** grep for `AuthCredential` outside `src/auth/`
must return nothing.

## Requirement clauses closed

Section 9 — all six:

- Passwords hashed with bcrypt
- Refresh token hash stored; logout revokes
- User endpoints reject an absent or invalid token
- Admin endpoints reject a user token
- Internal key yields a service principal with no user identity
- Internal endpoints reject "act on behalf of" semantics

The last two need an internal endpoint to assert against. Ticket 023 provides
`POST /v1/internal/provisioning/run`; if this ticket lands first, assert against a throwaway
internal route and move the assertion when the real one exists.

## Answer

Shipped through OpenSpec change `build-auth-module`. **Four of the six clauses closed; the two
internal-key clauses go to ticket 023.** The throwaway-route option above was taken up and then
rejected on contact: a guard whose only caller is a probe controller inside a test is a guard written
against an imagined endpoint, and `INTERNAL_API_KEY` is already in configuration waiting for it. The
coverage table records both clauses as ticket 023's so the deferral cannot be forgotten.

**The module was built twice.** The first plan ran to 24 files and 51 tasks — a `TokenService`, a
repository layer in both modules, a `password-hashing` wrapper, an injected `Clock`, a hand-written
`'15m' → 900` parser, a nine-export constants file, and a type-level spec of its own. — the same reference read for ticket 019 — settled it:
that module is roughly 230 lines of code, injects `PrismaService` straight into its `AuthService`,
and has no repository directory at all. **Final: 13 source files, 30 tasks, 23 new tests.**

Three rules came out of the cut, and they apply to every remaining build ticket:

- **`repositories/` is now conditional in [`module-boundaries.md`](../../architecture/module-boundaries.md)** —
  required where a module has real query surface, not where every method forwards one call to Prisma.
  What the seam rests on is table ownership, which `auth-seam.spec.ts` enforces directly.
- **Build an operation when a caller exists.** The internal-key guard is the first application.
- **The injected `Clock` is for domain time, not for JWTs.** A token's `exp` is checked against wall
  clock by everyone who receives it, so binding it to a fake clock is wrong, not merely redundant.

**Guards are plain, written against `JwtService`; Passport was removed** (four packages). `HS256` is
pinned once in `JwtModule.registerAsync` through `signOptions` and `verifyOptions`, so no call site
can lose it. Access and refresh tokens are both JWTs signed with the same secret and separated by a
`tokenType` claim — named that, not `typ`, because `jsonwebtoken` already writes `typ: 'JWT'` into
the JOSE header.

**The refresh token is a JWT because the schema has nowhere to put an expiry.** The reference stores
an opaque UUID in a `RefreshToken` table with `expiresAt`; `AuthCredential` has one nullable column
and no expiry, so `exp` rides in the token and the stored SHA-256 hash carries revocation. No
migration.

**Found by test: rotation returned an identical token.** A JWT is a pure function of payload,
issued-at second, and secret, so refreshing inside the same second reissued the same string — the
stored hash matched and "a refresh token works exactly once" held only by luck of timing. Refresh
tokens now carry a `jti`; access tokens do not.

**The first ADMIN is `prisma/seed-admin.ts`, exported so tests call it after truncation** — the
harness truncates `User` before every test, so a once-at-setup seed would not survive.
`auth ──▶ billing` was added to the dependency graph, putting `auth` at the top where deleting it
breaks nothing, and registration's transaction is left open at the point ticket 023 extends it.
