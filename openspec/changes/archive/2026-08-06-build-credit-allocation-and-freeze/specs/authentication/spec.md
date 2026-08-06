## MODIFIED Requirements

### Requirement: Admin endpoints require the ADMIN role

An endpoint marked as requiring `ADMIN` SHALL reject a valid `USER` token with `403` and code
`FORBIDDEN`, and an absent or invalid token with `401`. The role SHALL be read from the verified
token, never from the request.

The marker decorator SHALL be published from `common/identity/` alongside the identity contract, and
the guard that reads it SHALL be registered globally by the auth module. A module that owns an admin
route SHALL be able to mark it without importing from `src/auth/`.

`credit` is a leaf and may not import from `auth`, but it owns
`POST /v1/admin/users/:userId/credits/adjust`. Registering the guard where the routes live would leave
it unenforced wherever it was forgotten; publishing the marker from `auth` would close the cycle
`auth ──▶ billing ──▶ credit ──▶ auth`. This is the same seam, and the same resolution, as the
identity contract.

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

#### Scenario: An admin route in a leaf module is guarded without declaring a guard

- **WHEN** an admin route in a module that imports nothing from `src/auth/` is reached by a `USER`
  token
- **THEN** the response is `403` with code `FORBIDDEN`

  The route declares the required role only; a module graph containing `auth` enforces roles by
  definition.

#### Scenario: A route marking no role is reachable by any authenticated caller

- **WHEN** a route carries no role marker and a valid `USER` token reaches it
- **THEN** the handler runs

  The global guard must let unmarked routes through, or registering it would close every existing
  user route.
