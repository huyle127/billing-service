# 031 Build subscription self-service and payment methods

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/ -->
<!-- blocked-by: 023, 025, 029, 034 -->

## Question

The `/v1/me` surface a user's own dashboard drives.

- `GET` `POST` `PATCH` `DELETE /v1/me/subscription`, `GET /v1/me/wallet`, and
  `GET` `POST` `DELETE /v1/me/payment-methods`, plus the `payment_method.attached` / `.detached`
  webhook handlers.
- **Every `/v1/me` route acts on the caller's own identity and none accepts a user id.** The
  admin surface is where another user's data is reachable, and only there.
- **`GET /v1/me/subscription` and `GET /v1/me/wallet` are served from the database alone.** They must
  answer immediately after registration, without waiting on Stripe having been reached — that is the
  entitlement-versus-money split from
  [`stripe-sync.md`](../../architecture/stripe-sync.md) made visible to the user.
- **Call provisioning defensively first** on any operation that needs a Stripe Customer. This is
  trigger three of the routine built in 023 — the last line of defence, on the one path where absence
  would actually hurt.
- `DELETE` sets `CANCELED` through the state machine (025). Access and credits continue to period end;
  nothing is deleted in Stripe immediately.
- `POST` on a paid plan may require 3DS/SCA, in which case the new Subscription is recorded as
  `PENDING` and **does not become current** (025). The user stays on Free until payment is confirmed.
- **Only references and metadata are stored** for payment methods — `stripePaymentMethodId`, brand,
  last4, expiry month and year. No PAN, no CVC, nothing Stripe would consider sensitive. Assert this
  against what the schema can even hold, not only against what the code writes.
- `PATCH` (plan or cycle change) produces proration in Stripe. **Its expected amounts depend on the
  account's `billing_mode`** — ticket 034 determines that, which is why this ticket blocks on it.
  Note that a mid-cycle change also grants a full new monthly credit allocation (027); that is
  intentional.

## Requirement clauses closed

Section 10:

- Sensitive payment data never stored locally

**Coverage gap to fix as part of this ticket.**
[`requirement-coverage.md`](../../testing/requirement-coverage.md) has no rows for the self-service
subscription endpoints or for payment methods — subscribe, change plan, and attach/detach have no
clause tracking them at all. Add the rows, then satisfy them. The checklist is the completion
criterion for this effort, so a behaviour missing from it is a behaviour nothing will notice is
absent.
