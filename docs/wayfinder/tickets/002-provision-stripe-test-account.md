# 002 Provision Stripe test account and CLI

<!-- parent: map-billing-service-build.md -->
<!-- label: wayfinder:task -->
<!-- mode: HITL -->
<!-- status: closed (2026-08-10) -->
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

## Forwarding verified — 2026-08-10

The last open item. `stripe listen --forward-to localhost:3000/v1/webhooks/stripe` was run by hand
against the endpoint ticket 024 built, and `stripe trigger` drove a full subscription cascade
through it. Twelve events forwarded, twelve `200`, twelve `WebhookEvent` rows — twelve distinct
`stripeEventId`, every one `COMPLETED` with a null `failureReason`:

`customer.created` · `product.created` · `plan.created` · `price.created` · `setup_intent.created` ·
`invoice.finalized` · `invoice.paid` · `invoice.created` · `invoice.payment_succeeded` ·
`customer.updated` · `customer.subscription.created` · `customer.subscription.trial_will_end`

Only the last has a handler; the other eleven took the unsubscribed-type path and completed without
work, which is the designed behaviour. What the run proves is the part that could only be proved
live: the CLI's signature verifies against the raw body preserved by 018, and the row is persisted.

**The secret already in `.env` is the CLI's** — no second entry was needed, so the list config that
ticket 024 built for rotation was not exercised here. It is still right to have: the Dashboard's
secret differs, and adding it later must not need a redeploy.

**The failure that cost the first attempt was ours, not Stripe's.** `stripe listen` answered
`dial tcp [::1]:3000: connectex` because nothing was listening — and the reason nothing was
listening is that `npm run build` silently emits nothing on any run after the first.
`nest-cli.json` sets `deleteOutDir: true` while `tsconfig.json` sets `incremental: true`, so nest
deletes `dist/`, tsc reads `tsconfig.build.tsbuildinfo`, concludes nothing changed, and skips the
emit. Exit code 0, empty `dist/`. Deleting the tsbuildinfo fixes the run; the standing fix is to
drop one of the two settings.

## Post-dunning behaviour recorded — 2026-08-10

Ticket 013 asked for this setting to be captured here and it never was. Found while proposing ticket
026, which is where it starts to matter.

**Dashboard → Billing → Automatic collection → "If all retries for a payment fail" is to be set to
`Cancel subscription`.** It is account-wide configuration with no API to read or write it, so it is
recorded here rather than asserted by a test.

The choice is forced by the lifecycle we own. `expire` is the transition that forfeits subscription
credits and creates the replacement Free subscription, and the only thing that drives it is
`customer.subscription.deleted`. Left on `unpaid`, Stripe emits no such event: the subscription keeps
generating invoices, our row sits in `PAST_DUE` for good, and — until ticket 026 widened the unfreeze
to every edge leaving `PAST_DUE` — the wallet would have stayed `FROZEN` with nothing able to thaw
it. `Cancel subscription` is the one value that makes `PAST_DUE → EXPIRED` reachable.

Nothing in the code reads it: ticket 013's ownership model means the setting cannot alter our
lifecycle silently, only starve it of the event that ends one.
