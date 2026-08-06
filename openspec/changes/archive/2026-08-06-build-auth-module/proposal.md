## Why

Implements wayfinder ticket [020 Build the auth module](../../../docs/wayfinder/tickets/020-build-auth-module.md),
unblocked by change `build-common-layer`. Designed in
[009 Design the auth module](../../../docs/wayfinder/tickets/009-design-auth-module.md).

Nothing in the service has a route yet, because every route is behind a token nobody issues. Four
later changes — the credit ledger, registration provisioning, the catalog admin CRUD, and
subscription self-service — address the caller as a verified user and cannot have a controller until
one exists.

The module is built to be deleted. Billing and credit depend on the user id and role a guard put on
the request, never on this module's storage, so replacing it with an upstream Authentication Service
means writing a new guard.

## What Changes

- **`src/user/`** — a `UserService` over the `User` table. `User` is what billing holds foreign keys
  against and it survives the auth module's removal.
- **`src/auth/`** — registration, login, refresh, and logout. bcrypt for passwords, HS256 for
  tokens, SHA-256 for the stored refresh hash.
- **Refresh tokens rotate.** A used refresh token stops working; logout clears the stored hash. The
  credential row holds one hash, so one active session per user.
- **Two guards** — `JwtAuthGuard` verifies the access token and puts `{ id, email, role }` on the
  request; `RolesGuard` reads `@Roles(Role.ADMIN)` through the `Reflector`, the standard NestJS
  pattern.
- **The registration transaction, with the seam ticket 023 extends.** `AuthService.register` opens
  one transaction and creates `User` and `AuthCredential` in it. The billing side — Free
  Subscription, Credit Wallet, first grant — is ticket 023 and joins at the same point.
- **`auth ──▶ billing` is added to the dependency graph** in
  [`module-boundaries.md`](../../../docs/architecture/module-boundaries.md), putting `auth` at the
  top. That is what makes it deletable: nothing depends on it.
- **`repositories/` becomes optional in `module-boundaries.md`.** A service whose repository would be
  a passthrough to Prisma calls Prisma directly. The layer stays required where a module has enough
  query surface to justify it.
- **The first ADMIN comes from `prisma/seed.ts`**, idempotently, from `ADMIN_EMAIL` and
  `ADMIN_PASSWORD`. No runtime route grants `ADMIN`.
- **Auth routes are added to [`api-surface.md`](../../../docs/architecture/api-surface.md)**, which
  documents user, admin, internal, and webhook routes but no authentication routes.
- **`@nestjs/passport`, `passport`, `passport-jwt`, and `@types/passport-jwt` are removed.** The
  guards are written directly against `JwtService`.

**Not in this change: the internal API key.** Requirements §9 defines a third access path for
service-to-service calls, and it has no caller yet — the endpoints behind it
(`POST /v1/internal/provisioning/run`, `POST /v1/internal/allocations/run`) belong to tickets 023 and
028. The guard ships with the first endpoint that needs it rather than ahead of it. `INTERNAL_API_KEY`
already exists in configuration from change `build-common-layer` and is left untouched.

**No schema change.** `User` and `AuthCredential` already exist. `AuthCredential.refreshToken` keeps
its name and stores the hash.

**No new configuration key reaches the service.** `ADMIN_EMAIL` and `ADMIN_PASSWORD` are read by
`prisma/seed.ts`, which runs outside the Nest container and already reads `DIRECT_URL` that way.

## Capabilities

### New Capabilities

- `authentication`: how a caller proves who they are — credential storage and the algorithms that
  protect it, token issuance, rotation and revocation, and the two guards that decide whether a
  request reaches its handler.

### Modified Capabilities

None. `platform` already specifies the configuration surface this change reads and the error
envelope its `401` and `403` responses use.

## Impact

- **New code**: `src/user/` (`services/`, `user.module.ts`) and `src/auth/` (`controllers/`,
  `services/`, `dto/`, `guards/`, `decorators/`, `auth.constants.ts`, `auth.module.ts`).
- **Existing code**: `src/app.module.ts` registers both modules. `prisma/seed.ts` gains the admin
  seed. Nothing under `src/common/` or `src/billing/` is modified.
- **Documentation**: `module-boundaries.md` gains the `auth ──▶ billing` edge and makes
  `repositories/` conditional; `api-surface.md` gains the authentication routes; `.env.example` gains
  `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and the `JWT_REFRESH_TOKEN_TTL` it is missing.
- **Dependencies**: four Passport packages removed; none added.
- **Downstream**: `build-credit-consumption`, `build-registration-provisioning`,
  `build-plan-catalog-admin`, and `build-subscription-self-service` each need the guards from this
  change.
- **Requirement coverage**: this change claims **four** of the six Section 9 clauses in
  `docs/testing/requirement-coverage.md`, verbatim:
  - *"Passwords hashed with bcrypt"*
  - *"Refresh token hash stored; logout revokes"*
  - *"User endpoints reject an absent or invalid token"*
  - *"Admin endpoints reject a user token"*

  The remaining two — *"Internal key yields a service principal with no user identity"* and
  *"Internal endpoints reject \"act on behalf of\" semantics"* — stay `todo` and are claimed by
  ticket 023, which builds the first endpoint they can be asserted against.
