## ADDED Requirements

### Requirement: The internal API key yields a service principal with no user identity
Internal endpoints SHALL admit only a caller presenting `INTERNAL_API_KEY`, and the principal they
yield SHALL carry no user identifier — it is set on a request property `@CurrentUser()` does not
read, and its type declares no field able to hold one.

#### Scenario: Only the internal key opens an internal route
- **WHEN** an internal route is called with no key, with a wrong key, and with a valid user access
  token
- **THEN** all three are refused, and the same route with the internal key is admitted

### Requirement: Internal endpoints reject act-on-behalf-of semantics
An internal endpoint SHALL operate only on its own scope — everything currently due — and SHALL
refuse a request naming a user to act for.

#### Scenario: A user identifier in the body is refused, not ignored
- **WHEN** an internal route is called with a valid internal key and a body carrying a user
  identifier
- **THEN** the request is refused by the global validation pipe and no routine runs
