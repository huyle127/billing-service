## Context

`src/auth/` and `src/user/` do not exist. This change creates both, and with them the first HTTP
controller in the service.

The design was recalibrated after reading a comparable NestJS billing service,
, whose auth module is roughly 230 lines of code and 150 lines
of test. An earlier draft of this change planned 24 files and three abstractions that module does
without. The measurements below are what the plan was cut against.

Decisions already closed are not reopened here:

- bcrypt for passwords, SHA-256 for the stored refresh hash, HS256 for signing; claims limited to
  subject, role and expiry — [009](../../../docs/wayfinder/tickets/009-design-auth-module.md),
  recorded in requirements §9
- registration creates `User` and `AuthCredential` and does not contact Stripe — same ticket,
  requirements §3
- the first ADMIN comes from `prisma/seed.ts`, and promoting the first registered user was rejected
  — [020](../../../docs/wayfinder/tickets/020-build-auth-module.md)
- module shape, table ownership, and the auth seam —
  [004](../../../docs/wayfinder/tickets/004-design-module-boundaries.md)
- OAuth and asymmetric keys are out of scope — [009](../../../docs/wayfinder/tickets/009-design-auth-module.md)

## Goals / Non-Goals

**Goals:**

- Issue and verify tokens, and put a verified user on the request for every later module to read.
- Leave the registration transaction with an obvious place for ticket 023 to add the billing side.
- Stay at the size of a normal NestJS auth module.

**Non-Goals:**

- **No internal API key guard.** Requirements §9 defines the third access path, but its endpoints
  belong to tickets 023 and 028. Building the guard now means building it against a probe controller
  that exists only in a test.
- No billing state at registration — ticket 023.
- No user profile endpoints, password reset, email verification, or account deletion. None is named
  by a requirement clause.
- No OAuth, no asymmetric keys, no multi-session support.
- No new error code, no schema change, no migration.

## Decisions

**Guards are written directly against `JwtService`; Passport is removed.** `JwtAuthGuard` extracts
the bearer token, verifies it, and assigns `request.user`. The reference module uses
`PassportStrategy` for the same work; both are about thirty lines, and doing it directly keeps the
verification visible in the file that depends on it rather than inside a `validate()` callback the
framework invokes. The four Passport packages installed while scaffolding are removed.

**`algorithms: ['HS256']` is pinned once, in `JwtModule.registerAsync`.** `JwtModuleOptions` carries
both `signOptions` and `verifyOptions`, so the pin lives in `auth.module.ts` and every `sign` and
`verify` inherits it. Repeating the option at each call site is how one of them eventually loses it,
which is the `alg: none` and algorithm-substitution family of attacks.

**The refresh token is a JWT whose SHA-256 hash is stored.** The reference implementation stores an
opaque `randomUUID()` in a dedicated `RefreshToken` table with an `expiresAt` column. This schema has
no such table — `AuthCredential` has one nullable `refreshToken` column and no expiry column — so an
opaque token would have to derive its expiry from `updatedAt`, which any other write to the row
moves. A JWT carries `exp` itself. Expiry is enforced by verification, revocation by the stored hash,
and no migration is needed.

**Tokens carry a `tokenType` claim, and each is rejected at the wrong door.** Both types are signed
with the same secret, so without a discriminator a thirty-day refresh token would be a valid bearer
credential. The claim is named `tokenType` and not `typ`: `jsonwebtoken` already writes
`typ: 'JWT'` into the JOSE header for every object payload (`sign.js`), so a payload claim of the
same name puts two differently-valued `typ` fields in one token.

**Refresh rotates: every refresh issues a new refresh token and overwrites the stored hash.** A
replayed token fails because the hash no longer matches. One hash per credential means one active
session — logging in on a second device ends the first. That is chosen, not overlooked: multi-session
means a session table, which the upstream service will own.

**`AuthCredential.refreshToken` keeps its name despite storing a hash.** Renaming costs a migration
on a table with no data. Declined to keep this change schema-free; the spec states what the column
holds, and nothing outside `src/auth/` reads it.

**Registration opens one transaction in `AuthService`, and participants take the transaction client
as a parameter.** `UserService.createInTransaction(tx, …)` runs, then the credential is written on
the same `tx`. Ticket 023 adds its billing calls to the same sequence.

**`auth ──▶ billing` is added to the dependency graph, putting `auth` at the top.** Ticket 023
extends the registration transaction with `BillingCustomer`, `Subscription`, and `CreditWallet`,
which the current graph has no edge for. The alternative — `billing` owning registration and calling
`auth` — points the dependency at the module designed to be deleted. Putting `auth` at the top is
what makes it deletable: nothing imports it.

**No repository layer in `auth` or `user`.** A `UserRepository` whose every method forwards one call
to Prisma is a third layer between the service and a generated, type-safe, already-mockable client.
The reference module injects `PrismaService` into its `AuthService` directly and has no
`repositories/` directory at all. `module-boundaries.md` is amended: the layer is required where a
module has enough query surface to justify it, not as a rule that holds at one query.

Table ownership is unaffected and is what the seam actually rests on — `AuthCredential` is written
only inside `src/auth/`, whether or not a repository class stands in front of it.

**The directory grouping stays.** `controllers/ services/ guards/ decorators/ dto/` is kept even
where a directory holds two files, because the reference module keeps it at the same size and
`billing/` will need it at forty-five files. Only `repositories/` is dropped.

**bcrypt is called directly, with the cost from `AppConfigService`.** An earlier draft wrapped
`bcrypt.hash` and `bcrypt.compare` in a two-function module so the seed and the service could not
disagree. They cannot disagree anyway: a bcrypt hash embeds its own cost, so a hash written by the
seed at one cost verifies against a service configured for another.

**Login does not distinguish an unknown email from a wrong password** — both return `401` with the
same message. A dummy hash comparison to equalise timing was considered and dropped: registration
returns `400` on a duplicate email, so the address is already discoverable, and hardening one path
while the other discloses buys nothing.

**The file layout this change lands:**

```
src/
  auth/
    controllers/auth.controller.ts
    services/auth.service.ts
    services/auth.service.spec.ts
    guards/jwt-auth.guard.ts
    guards/roles.guard.ts
    decorators/current-user.decorator.ts
    decorators/roles.decorator.ts
    dto/register.dto.ts
    dto/login.dto.ts
    dto/refresh-token.dto.ts
    auth.constants.ts
    auth.module.ts
  user/
    services/user.service.ts
    services/user.service.spec.ts
    user.module.ts
```

`auth.constants.ts` holds one thing: the two token type values, which `auth.service.ts` and
`jwt-auth.guard.ts` must agree on. Everything else an earlier draft put there — the bearer scheme,
the request property, the claim name, the digest name, the algorithm — is used in exactly one file.

## Risks / Trade-offs

- **One refresh hash means one session.** → Stated in the spec so it is a known property. The fix is
  a session table, which belongs to the service that replaces this module.
- **`auth ──▶ billing` gives the top module a reach into the largest one.** → Bounded by direction:
  `billing` never imports `auth`, so the edge disappears with the module.
- **Dropping the repository layer here makes the codebase inconsistent with `billing/`, which will
  have one.** → The amended rule states the condition, so the difference is legible rather than
  arbitrary. The alternative is a passthrough class per table for the sake of symmetry.
- **The internal API key is specified in requirements §9 but not built here.** → Two coverage clauses
  stay `todo` and are named as ticket 023's. The risk is that the deferral is forgotten; the coverage
  table is what prevents that, since it is this effort's completion criterion.
- **`tokenType` is enforced by our own verification.** → Both directions are asserted: an access
  token at the refresh endpoint, and a refresh token as a bearer credential.

## Migration Plan

None. No schema change and no configuration key reaching the service. Had a schema change been needed
— the `refreshToken` → `refreshTokenHash` rename considered above is the one that was on the table —
it would ship as `prisma migrate diff --from-config-datasource --to-schema` followed by
`prisma migrate deploy`, never `db push` and never `migrate dev` in a non-interactive shell.

`ADMIN_EMAIL` and `ADMIN_PASSWORD` are added to `.env.example` and must be set before
`npm run db:seed` produces an admin; an existing database without them keeps working.

## Open Questions

None. The `typ` question is resolved above; the internal API key is deferred rather than open.

## Discovered during implementation

- **Rotation produced an identical refresh token.** A JWT is a pure function of its payload, its
  `iat` second, and the secret, so refreshing within the same second as the previous issue returned
  the *same string* — the stored hash matched, and "a refresh token works exactly once" silently did
  not hold. Refresh tokens now carry a `jti` of `randomUUID()`. Access tokens do not: their identity
  is never compared against anything, and the claim set stays minimal where minimalism costs nothing.
  Caught by the end-to-end HTTP test, which is the only place two issues land close enough together
  to collide.
- **`expiresIn` will not accept a plain `string`.** `@nestjs/jwt` types it as
  `number | StringValue | undefined`, where `StringValue` is the `ms` package's template literal
  type, and `AppConfigService` returns `string`. The value is cast to `JwtSignOptions['expiresIn']`
  at the one call site rather than pulling `ms` in as a direct dependency or widening the config
  accessor. Consequence worth knowing: a malformed `JWT_ACCESS_TOKEN_TTL` now fails at the first
  login rather than at boot, which is weaker than the boot-time validation `platform` promises for
  configuration. Tightening it means a format check in `common/config`, which this change stayed out
  of.
- **`.env.example` already carried `JWT_REFRESH_TOKEN_TTL`; `.env` did not.** The task list had it
  the wrong way round. Both now carry it, along with the admin credentials.
- **The `.env.example` comment for `JWT_SECRET` still said ticket 009 might replace it with an
  RSA/EC key pair.** Ticket 009 closed by rejecting asymmetric keys. Corrected in passing.
