# 005 Amend requirements for auth scope override

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: closed (2026-08-04) -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

`docs/requirements/billing-service-requirements.md` §11 lists "User authentication system" as out
of scope, and §9 states the service "does not manage user authentication lifecycle". This effort
has deliberately overridden that: a minimal auth module (registration, login, bcrypt, JWT,
USER/ADMIN roles) is now in scope so the service is self-contained for development and
demonstration.

The requirements document and the map currently disagree. Amend the document so it records the
override and its rationale — that the module exists for development and demonstration only, and
is expected to be replaced by an upstream Authentication Service.

Small and mechanical, but it should happen before the auth module is designed in 009, so the
design has a consistent source document to work from.

## Answer

Resolved as part of ticket 009, which rewrote the same section.

§9 now opens with an explicit scope note recording the override and its rationale — the module
exists for development and demonstration and is built to be deleted.

§11 no longer contradicts it. Rather than removing the line, the out-of-scope entry was **narrowed**
to what genuinely remains excluded: federated and social login, multi-factor authentication,
password reset, session management, and account recovery. Deleting the entry outright would have
implied this project ships a production authentication system, which it does not.
