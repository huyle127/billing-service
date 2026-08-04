# 002 Provision Stripe test account and CLI

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: HITL -->
<!-- status: open -->
<!-- assignee: -->
<!-- blocked-by: -->

## Question

Nothing to decide — manual setup that must exist before any Stripe behaviour can be judged,
researched against a real dashboard, or tested.

Checklist for the human:

- Create a Stripe account and stay in **test mode** throughout this effort.
- Capture the test secret key and publishable key; store them where 001 established secrets live.
- Install the Stripe CLI and authenticate it.
- Verify `stripe listen --forward-to localhost:<port>/webhooks/stripe` runs and prints a webhook
  signing secret; capture that secret too.
- Note whether Stripe Products and Prices for Free, Pro monthly, Pro annual, and the add-on credit
  packages already exist or must be created — this feeds ticket 008.

## Answer

Mostly resolved. Verified live against the Stripe API on 2026-08-04.

- **Account** `acct_1TlhMSFaNFL0w4nv`, country US, default currency USD, test mode confirmed.
  `charges_enabled` is currently `false`, which is normal for an account whose business details are
  not filled in and does not block test-mode charges — worth re-checking if a charge unexpectedly
  fails.
- **Keys** live in `.env` (git-ignored): `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`. Stripe CLI is installed and on PATH.
- **The account is not empty.** It already carries a plan catalog matching this domain:

| Product | Price | Amount | Interval |
| --- | --- | --- | --- |
| AI Free `prod_UyPWFhOF4FGfZG` | `price_1TyShMFaNFL0w4nvycCBFDng` | **$0** | monthly |
| AI Pro `prod_UyPW72r45f4tLB` | `price_1TyShOFaNFL0w4nvlpwgxLOU` | $20.00 | monthly |
| AI Pro | `price_1TyShPFaNFL0w4nv6QK6wNCv` | $200.00 | yearly |
| AI Credits `prod_UyPWQJbQpBKAhH` | `price_1TyShQFaNFL0w4nvNMULBWHi` | $10.00 | one-time |
| AI Credits | `price_1TyShRFaNFL0w4nvoIqQ8ScX` | $40.00 | one-time |

- **Nine leftover products pollute the account** — seven named `myproduct` and two named
  `Dahlia Verify Pro`, all still `active`, from earlier experiments. Any catalog sync or admin
  listing that reads Stripe Products will pick these up. Either archive them or make the catalog
  filter explicitly; this is an input to ticket 008.

**Consequences for other tickets:**

- **Ticket 014** — a $0 monthly recurring price for Free already exists, which is evidence that the
  intended design treats Free as a real Stripe subscription rather than local-only state.
- **Ticket 015** can now test against `price_1TyShMFaNFL0w4nvycCBFDng` instead of creating one.
- **Ticket 008** — the catalog exists in Stripe first, which strengthens the case for Stripe (or a
  local table referencing these Price IDs) as source of truth rather than static config.

**Not yet verified:** that `stripe listen --forward-to` actually delivers to our endpoint. A
signing secret is present in `.env`, implying the command has been run, but end-to-end forwarding
cannot be confirmed until an application exists to receive it. This ticket stays open for that
check, which should happen as part of ticket 001.
