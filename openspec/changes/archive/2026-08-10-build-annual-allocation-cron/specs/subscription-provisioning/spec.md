## ADDED Requirements

### Requirement: The provisioning sweep is reachable from an internal endpoint
`POST /v1/internal/provisioning/run` SHALL invoke the same sweep the in-process schedule invokes,
so an external scheduler can drive it without a logic change.

#### Scenario: The endpoint sweeps what the schedule would have swept
- **WHEN** a subscription is awaiting its Stripe objects and the internal endpoint is called
- **THEN** the subscription is provisioned and the response reports what the run completed
