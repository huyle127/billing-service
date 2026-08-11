# admin-billing-view Specification

## Purpose
TBD - created by archiving change build-plan-catalog-admin. Update Purpose after archive.
## Requirements
### Requirement: An admin reads one user's billing state from local rows
`GET /v1/admin/users/:userId/billing` SHALL answer with that user's subscription and wallet balances
from local rows, and SHALL be refused for a caller without the admin role.

#### Scenario: A user token cannot read another user's billing state
- **WHEN** the route is called with a user access token, and again with an admin token
- **THEN** the first is refused with `403` `FORBIDDEN` and the second returns the named user's
  subscription and both balances

