## 1. The user module

- [x] 1.1 Create `src/user/services/user.service.ts` — injects `PrismaService` directly, with `createInTransaction(tx, …)`, `findByEmail`, and `findById`. No repository layer
- [x] 1.2 Add `user.module.ts` exporting `UserService`, and register it in `app.module.ts`
- [x] 1.3 `services/user.service.spec.ts`: a write made with a supplied transaction client rolls back with that transaction, and find-by-email returns nothing for an unregistered address

## 2. Auth service

- [x] 2.1 Create `src/auth/auth.constants.ts` with the two token type values and their union type — the one string `auth.service.ts` and `jwt-auth.guard.ts` must agree on
- [x] 2.2 Add `auth.module.ts` with `JwtModule.registerAsync`, pinning `signOptions.algorithm` and `verifyOptions.algorithms` to `HS256` in one place so no call site repeats it
- [x] 2.3 Implement `services/auth.service.ts` registration: open one transaction, call `UserService.createInTransaction(tx, …)`, then write the credential on the same `tx` with `bcrypt.hash` at the configured cost. Leave the sequence shaped so ticket 023 adds its billing calls at the same point
- [x] 2.4 Implement login — `bcrypt.compare` against the stored hash, issue both tokens, store the refresh token's SHA-256 hash. An unknown email and a wrong password return the same `401` message
- [x] 2.5 Implement refresh with rotation — verify the token as a refresh token, match its SHA-256 against the stored hash, issue a new pair, overwrite the hash
- [x] 2.6 Implement logout — clear the stored refresh hash
- [x] 2.7 Registration on a duplicate email raises `ValidationError`, surfacing as `400 VALIDATION_FAILED`; the `@unique` constraint on `User.email` is what decides
- [x] 2.8 `services/auth.service.spec.ts`: the stored row holds a bcrypt hash and never the password, a refresh token works once and its replacement is refused, and logout clears the hash

## 3. Guards, decorators, DTOs, controller

- [x] 3.1 Implement `guards/jwt-auth.guard.ts` — extract the bearer token, verify it as an access token, assign `request.user` as `{ id, email, role }`, throw `UnauthorizedException` otherwise
- [x] 3.2 Implement `decorators/roles.decorator.ts` and `guards/roles.guard.ts` using the `Reflector`, the standard NestJS pattern
- [x] 3.3 Implement `decorators/current-user.decorator.ts`
- [x] 3.4 Add `dto/register.dto.ts`, `dto/login.dto.ts`, and `dto/refresh-token.dto.ts` with class-validator decorators. Logout takes no body — it reads the user from the request
- [x] 3.5 Add `controllers/auth.controller.ts` serving register, login, refresh, and logout, with no business logic
- [x] 3.6 Register `AuthModule` in `app.module.ts`
- [x] 3.7 Remove `@nestjs/passport`, `passport`, `passport-jwt`, and `@types/passport-jwt` from `package.json` and confirm nothing imports them

## 4. The admin seed

- [x] 4.1 Create `prisma/seed-admin.ts` exporting `seedAdmin(client)` — reads `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `BCRYPT_SALT_ROUNDS` from the environment, creates `User` and `AuthCredential` in one transaction, skips when the email exists, and skips with a warning when either value is absent. Admin tests call it themselves after truncation
- [x] 4.2 Call it from `prisma/seed.ts` after the catalog, leaving catalog seeding unchanged
- [x] 4.3 Add `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and the missing `JWT_REFRESH_TOKEN_TTL` to `.env.example`, and set the admin values in `.env`
- [x] 4.4 Test: running the seed twice leaves one admin whose credential verifies `ADMIN_PASSWORD`

## 5. HTTP tests

- [x] 5.1 `test/auth-http.spec.ts`: register, login, refresh, logout end to end against the test database
- [x] 5.2 Test: registering the same email twice returns `400 VALIDATION_FAILED` and leaves one user
- [x] 5.3 Test: a protected endpoint rejects an absent, malformed, wrongly-signed, expired, and refresh-typed token, each `401` with code `UNAUTHORIZED`; a valid token reaches the handler with the id from the token
- [x] 5.4 Test: an admin endpoint returns `403 FORBIDDEN` for a `USER` token, `401` for no token, and runs for an `ADMIN` token seeded through `seedAdmin`
- [x] 5.5 Test: an access token is refused at the refresh endpoint

## 6. Boundaries and close out

- [x] 6.1 Amend `docs/architecture/module-boundaries.md`: record the `auth ──▶ billing` edge with its reason, and make `repositories/` conditional on a module having query surface to justify it rather than required at one query
- [x] 6.2 Add the auth routes to `docs/architecture/api-surface.md`
- [x] 6.3 Add `src/auth/auth-seam.spec.ts`: fails if `AuthCredential` appears outside `src/auth/`, the Prisma schema, and its migrations
- [x] 6.4 Run `npm run build`, `npm test`, and `npm run lint`; all three pass
- [x] 6.5 Confirm `prisma/schema.prisma` is unmodified, no migration was generated, and no configuration key was added to `src/common/config/`
- [x] 6.6 Update `docs/testing/requirement-coverage.md`: move the four claimed Section 9 clauses to `covered` with the test that asserts each, and annotate the two internal-key clauses as ticket 023's
- [x] 6.7 Close wayfinder ticket 020: post the answer including the deferral of the internal API key, mark it closed, and add its one-line gist to the map's Decisions-so-far
