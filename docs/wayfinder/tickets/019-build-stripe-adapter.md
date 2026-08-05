# 019 Build the Stripe adapter seam and its test fake

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: AFK -->
<!-- status: open -->
<!-- assignee: -->
<!-- output: src/billing/stripe/ -->
<!-- blocked-by: 018 -->

## Question

What interface does `billing/stripe/` expose, and what is the fake that every integration test runs
against?

Ticket 004 called this a real seam rather than a hypothetical one, precisely because the test fake
is a second adapter. Build both together or the interface will be shaped by only one caller.

- **`StripeService`** is the only place `stripe` SDK types are visible. Everything above it sees
  domain types.
- **Pin `apiVersion` explicitly** to `2026-07-29.dahlia`, on the client and on the webhook endpoint,
  rather than inheriting the account default. Silent version drift is not hypothetical here:
  `2025-03-31.basil` moved `current_period_end` off the Subscription object and restructured
  Invoice, and it would break the credit path without an error.
- Operations later tickets need: create and retrieve Customer; create, retrieve, update and cancel
  Subscription; create Product and Price; archive Price; attach and detach PaymentMethod; retrieve
  Invoice; create a one-time payment for add-ons; construct and verify webhook events against a
  **list** of signing secrets.
- **Idempotency keys derived from our own identifiers** — `customer:{userId}`,
  `subscription:{subscriptionId}`, the plan `code` for catalog writes. A retry inside Stripe's
  window returns the original object instead of creating a second.
- **Metadata tagging.** Every object we create carries `metadata.userId`, and subscriptions carry
  `metadata.subscriptionId`. This matters because **Stripe's idempotency keys expire after 24
  hours** — a retry after a long outage falls outside the window and the key no longer protects us.
  Search by metadata before creating, and adopt what is found. Metadata is also the only thing that
  makes an orphaned Stripe object traceable back to a user.
- **Error classification** — retryable (network, rate limit, 5xx) versus permanent (invalid
  request). Both the webhook worker and the sync reconciler branch on it; without it a malformed
  request retries until it exhausts its budget instead of failing fast.
- **The fake.** A second adapter behind the same interface, stateful enough to carry a subscription
  through its lifecycle. Ticket 003 eliminated the obvious alternatives: `stripe-mock` is stateless
  by design and Stripe has said it will stay so, and `stripe trigger` creates real objects and fires
  cascading events, so a test asserting on one event receives several. Webhook tests construct and
  sign their own payloads with the test signing secret — no network, deterministic, and able to
  produce sequences Stripe would rarely emit.

Account facts from ticket 002: `acct_1TlhMSFaNFL0w4nv`, test mode, the Free/Pro/add-on catalog
already exists, and **nine leftover products pollute the account** — seven named `myproduct`, two
named `Dahlia Verify Pro`. Nothing in this service may enumerate the catalog from Stripe.

Closes no requirement clause directly. Every Stripe-touching ticket depends on it.
