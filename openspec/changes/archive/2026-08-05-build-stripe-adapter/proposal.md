## Why

Implements wayfinder ticket [019 Build the Stripe adapter seam and its test fake](../../../docs/wayfinder/tickets/019-build-stripe-adapter.md),
unblocked by change `build-common-layer`. Five later changes — registration provisioning, webhook
ingestion, the catalog, upgrades, and add-on purchase — each need to talk to Stripe, and every one of
their integration tests needs Stripe faked. Without this change each invents its own client, its own
idempotency scheme, and its own stub, and the seam ticket 004 called real becomes a hypothetical one
shaped by whichever caller arrives first.

The fake ships in the same change as the interface on purpose: a seam with one implementation is a
guess. Building both together is what proves the interface can be satisfied by something other than
the SDK.

## What Changes

- **`StripeService` in `src/billing/stripe/`** — the only place `stripe` SDK types are visible.
  Everything above it takes and returns domain types.
- **`apiVersion` pinned explicitly to `2026-07-29.dahlia`** on the client and on webhook event
  construction, rather than inherited from the account default.
- **The operation set later tickets need**: create and retrieve Customer; create, retrieve, update
  and cancel Subscription; create Product and Price; archive Price; attach and detach PaymentMethod;
  retrieve Invoice; create a one-time payment for add-ons; find an object by our metadata; construct
  and verify a webhook event against a **list** of signing secrets.
- **Idempotency keys derived from our own identifiers** — `customer:{userId}`,
  `subscription:{subscriptionId}`, the plan `code` for catalog writes — applied by the adapter, not
  by each caller.
- **Metadata tagging on every object we create** — `metadata.userId`, and `metadata.subscriptionId`
  on subscriptions — plus a metadata search callers use to adopt an existing object instead of
  creating a second once Stripe's 24-hour idempotency window has passed.
- **Error classification** — every SDK error is translated into a domain error carrying a
  retryable/permanent verdict, so the webhook worker and the sync reconciler branch on our type
  rather than on `stripe.errors.*`.
- **`FakeStripeAdapter`** — a second adapter behind the same interface, stateful enough to carry a
  subscription through its lifecycle, and able to sign a payload with the test signing secret so
  webhook tests need no network.

No schema change. No new runtime dependency — `stripe@^22.4.0` is already in `package.json`.

Nothing in this change enumerates the Stripe catalog. Account `acct_1TlhMSFaNFL0w4nv` carries nine
leftover products from earlier experiments, so a list call would return objects this service has
never heard of.

## Capabilities

### New Capabilities

- `stripe-adapter`: the boundary between this service and Stripe — which operations exist, how
  duplicate creation is prevented across both the idempotency window and beyond it, how failures are
  classified for the callers that retry, and the guarantee that a test can substitute a fake for the
  whole surface.

### Modified Capabilities

None. `platform` already specifies the config surface this change reads (the Stripe secret key and
the signing-secret list) and the raw-body guarantee signature verification depends on; neither
requirement changes.

## Impact

- **New code**: `src/billing/stripe/` — `interfaces/` holds the contract, `adapters/` the SDK-backed
  and fake implementations, `types/` the domain types crossing the seam, with the constants, the
  error classification, the shared verifier, and a Nest module exporting the contract by injection
  token so a testing module can swap the implementation.
- **Existing code**: `src/app.module.ts` registers the new module. Nothing under `src/common/` is
  modified.
- **Configuration**: no new keys. `STRIPE_SECRET_KEY` and the signing-secret list already exist from
  change `build-common-layer`.
- **Downstream**: `build-registration-provisioning`, `build-webhook-ingestion-and-worker`,
  `build-plan-catalog-admin`, and every other Stripe-touching change depend on this one. The
  interface shape is a contract between them, and widening it later is cheap while changing the
  meaning of an existing operation is not.
- **Requirement coverage**: this change claims **no clause** in
  `docs/testing/requirement-coverage.md`. Every clause that touches Stripe is stated as behaviour of
  a flow — provisioning, ingestion, allocation — and is asserted by the change that builds that flow.
  In particular *"Signature verification against the raw body"* stays `todo` here: the adapter
  verifies a signature, but the clause is about the live webhook route and belongs to
  `build-webhook-ingestion-and-worker`. Verification for this change is its own test suite —
  the fake and the real adapter answering the same interface, idempotency keys and metadata present
  on every create, and the classification verdict correct for each error family.
