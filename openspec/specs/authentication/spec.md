# authentication

## Purpose

How a caller proves who they are: credential storage and the algorithms that protect it, token
issuance, rotation and revocation, and the two guards that decide whether a request reaches its
handler. The module is built to be deleted — every other module depends on the identity a guard puts
on the request, never on the storage behind it.

## Requirements

### Requirement: Passwords are stored only as bcrypt hashes

The service SHALL hash every password with bcrypt at the configured cost before storing it, and SHALL
NOT store or log the password itself.

bcrypt is chosen because a password is human-chosen and therefore guessable; a fast hash such as
SHA-256 would allow billions of guesses per second against a stolen database.

#### Scenario: A registered password is unrecoverable from storage

- **WHEN** a user registers with a password
- **THEN** the stored credential contains a bcrypt hash carrying its own cost factor
- **AND** the plaintext password appears nowhere in the stored row

#### Scenario: A hash written at a different cost still verifies

- **WHEN** a credential was hashed at a cost other than the one now configured
- **THEN** login with the correct password still succeeds

  The cost is embedded in the hash, which is why the seed script can hash without reading the
  service's configuration.

### Requirement: Registration creates the user and the credential in one transaction

Registration SHALL create the `User` and its `AuthCredential` in a single transaction, so that
neither can exist without the other. It SHALL NOT contact any external service.

#### Scenario: Both rows land together

- **WHEN** registration succeeds for a new email address
- **THEN** a `User` and its `AuthCredential` both exist
- **AND** the user's role is `USER`

#### Scenario: A failure part-way leaves nothing behind

- **WHEN** the transaction fails after the user row has been written
- **THEN** no `User` row remains for that email address

#### Scenario: An already-registered email is refused

- **WHEN** registration is attempted with an email that already exists
- **THEN** the response is `400` with code `VALIDATION_FAILED`
- **AND** no second user is created

  Uniqueness is enforced by the `@unique` constraint on `User.email`, so this is asserted by
  attempting the duplicate rather than by trusting a pre-check.

### Requirement: Login issues an access token and a refresh token

On correct credentials the service SHALL return a short-lived access token and a refresh token, and
SHALL store the SHA-256 hash of that refresh token against the credential record.

SHA-256 rather than bcrypt: a refresh token is a high-entropy machine-generated value with no
dictionary to attack, so bcrypt's deliberate cost would buy nothing and would be paid on every
refresh.

#### Scenario: Correct credentials return both tokens

- **WHEN** login is called with a registered email and its password
- **THEN** the response carries an access token and a refresh token
- **AND** the stored credential holds the SHA-256 hash of the returned refresh token, not the token

#### Scenario: Wrong credentials are refused the same way whether or not the email exists

- **WHEN** login is called with an unregistered email, and separately with a registered email and the
  wrong password
- **THEN** both responses are `401` with code `UNAUTHORIZED` and the same message

### Requirement: Refresh rotates the token and revokes the one it replaces

Refresh SHALL accept a refresh token whose SHA-256 hash matches the stored hash, issue a new access
token and a new refresh token, and overwrite the stored hash. A refresh token that does not match the
stored hash SHALL be refused.

One hash is stored per credential, so a user has one active session; logging in again ends the
previous one. Multi-session support means a session table, which belongs to the service that replaces
this module.

#### Scenario: A refresh token works exactly once

- **WHEN** a refresh token is presented and accepted
- **THEN** new access and refresh tokens are returned
- **AND** the new refresh token differs from the one it replaces, even when both are issued within
  the same second
- **AND** presenting the original refresh token again is refused with `401`

  A JWT is a pure function of its payload, its issued-at second, and the secret, so a refresh token
  carries a unique identifier. Without it, rotating twice in the same second returns the same string
  and the guarantee above holds only by accident of timing.

#### Scenario: A structurally valid but unmatched token is refused

- **WHEN** a correctly signed, unexpired refresh token is presented whose hash is not the stored one
- **THEN** the response is `401`

  Signature validity alone is not sufficient; the stored hash is what makes revocation possible.

### Requirement: Logout revokes the refresh token

Logout SHALL clear the stored refresh token hash, after which no refresh token for that user is
accepted until the next login.

#### Scenario: After logout the refresh token stops working

- **WHEN** a user logs out and then presents the refresh token issued before logout
- **THEN** the response is `401`
- **AND** the stored refresh hash is null

### Requirement: Tokens are HS256 and carry subject, role, expiry, and their type

Tokens SHALL be signed with HS256 using the configured secret and SHALL carry only the subject, the
role, the expiry, and a claim identifying the token as an access or a refresh token. Issuer and
audience claims SHALL be omitted. Verification SHALL accept the `HS256` algorithm only, and SHALL
reject a token presented where the other type is expected.

Both token types are signed with the same secret. Without the type claim a thirty-day refresh token
would be a valid bearer credential, undoing the point of short-lived access tokens. Pinning the
algorithm closes the `alg: none` and algorithm-substitution attacks.

#### Scenario: An access token carries the claims and nothing more

- **WHEN** an issued access token is decoded
- **THEN** it carries the user id as subject, the role, an expiry, and the access type
- **AND** it carries no issuer and no audience claim

#### Scenario: A refresh token is not accepted as a bearer credential

- **WHEN** a refresh token is sent as the bearer token to a protected endpoint
- **THEN** the response is `401`

#### Scenario: An access token is not accepted at the refresh endpoint

- **WHEN** an access token is sent to the refresh endpoint
- **THEN** the response is `401`

#### Scenario: A token signed with another algorithm is refused

- **WHEN** a token whose header declares an algorithm other than `HS256` is presented
- **THEN** the response is `401`

### Requirement: Protected endpoints require a valid access token

An endpoint behind the authentication guard SHALL reject a request with no token, a malformed token,
a token signed with another secret, or an expired token, with `401` and code `UNAUTHORIZED`. On
acceptance it SHALL put the user's id, email, and role on the request.

#### Scenario: An absent or invalid token is rejected

- **WHEN** a request reaches a protected endpoint with no `Authorization` header, or with a token
  that is malformed, signed with a different secret, or expired
- **THEN** the response is `401` with code `UNAUTHORIZED`
- **AND** the handler does not run

#### Scenario: A valid token reaches the handler as a verified user

- **WHEN** a request carries a valid access token
- **THEN** the handler receives that user's id and role
- **AND** the id comes from the token, never from the request body or path

### Requirement: Admin endpoints require the ADMIN role

An endpoint marked as requiring `ADMIN` SHALL reject a valid `USER` token with `403` and code
`FORBIDDEN`, and an absent or invalid token with `401`. The role SHALL be read from the verified
token, never from the request.

#### Scenario: A user token is refused on an admin route

- **WHEN** a valid token whose role is `USER` reaches an admin endpoint
- **THEN** the response is `403` with code `FORBIDDEN`
- **AND** the handler does not run

#### Scenario: An admin token is accepted

- **WHEN** a valid token whose role is `ADMIN` reaches an admin endpoint
- **THEN** the handler runs

#### Scenario: Authentication failure outranks authorization failure

- **WHEN** no token at all reaches an admin endpoint
- **THEN** the response is `401`, not `403`

### Requirement: The first ADMIN is created only by the seed script

The seed script SHALL create an `ADMIN` user from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, idempotently,
skipping when a user with that email already exists and skipping with a warning when either value is
absent. No runtime endpoint SHALL grant the `ADMIN` role.

`User.role` defaults to `USER` and every admin route needs an admin token, so without this nothing
could ever call one. Promoting the first registered user was rejected: it turns registration into a
privilege-escalation race.

#### Scenario: The seed creates an admin, and running it again changes nothing

- **WHEN** the seed runs twice against a database with no user at `ADMIN_EMAIL`
- **THEN** exactly one user with that email and role `ADMIN` exists
- **AND** its credential verifies `ADMIN_PASSWORD`

#### Scenario: Missing admin configuration does not break seeding

- **WHEN** the seed runs with `ADMIN_EMAIL` or `ADMIN_PASSWORD` unset
- **THEN** it completes and seeds the catalog
- **AND** it reports that no admin was created

### Requirement: Nothing outside the auth module reads credential storage

`AuthCredential` SHALL be read and written only within `src/auth/`. Every other module SHALL depend
on the user id and role a guard put on the request, so that replacing this module means writing a new
guard.

#### Scenario: The credential table has exactly one reader

- **WHEN** `src/` is searched for `AuthCredential`
- **THEN** every hit is inside `src/auth/`

  The Prisma schema, its migrations, and `prisma/seed-admin.ts` are outside `src/` and are not
  modules; the seed writes the first ADMIN by design.

