# 020 Build the auth module

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
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
