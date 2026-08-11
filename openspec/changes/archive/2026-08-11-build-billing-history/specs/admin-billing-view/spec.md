## MODIFIED Requirements

### Requirement: An admin reads one user's billing state from local rows
`GET /v1/admin/users/:userId/billing` SHALL answer with that user's subscription, wallet balances,
and a first page of billing history with its cursor, from local rows, and SHALL be refused for a
caller without the admin role. The page SHALL carry a fixed limit and SHALL accept a `cursor` query
parameter to read further, using the same rows, ordering, and cursor as `GET /v1/me/history`.

#### Scenario: A user token cannot read another user's billing state
- **WHEN** the route is called with a user access token, and again with an admin token
- **THEN** the first is refused with `403` `FORBIDDEN` and the second returns the named user's
  subscription, both balances, and a history page

#### Scenario: The admin pages the named user's history without leaving the route
- **WHEN** an admin calls the route again with the cursor the previous response returned
- **THEN** the next page of that user's history returns, repeating no row from the first
