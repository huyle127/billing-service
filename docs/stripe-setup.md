# Stripe setup

The catalog in this repository and the objects in your Stripe account are one
procedure, not two. The seed writes plan economics (credit amounts, prices,
billing intervals); Stripe holds the Price objects those correspond to. The two
are joined by the Stripe Price identifiers you put in `.env`.

A fresh Stripe test account produces different identifiers every time, which is
why they are environment variables rather than values committed to the catalog.

## 1. Prerequisites

- A Stripe account in **test mode**.
- The [Stripe CLI](https://stripe.com/docs/stripe-cli), logged in with
  `stripe login`.

## 2. Create the products and prices

Amounts below are the catalog's configuration, defined in
`src/catalog/catalog-seed.ts`. **If you change one, change the other** — the
seed does not read amounts back from Stripe, so a mismatch is silent.

| Stripe Product | Stripe Price          | Amount  | Recurrence  | Local catalog row          |
| -------------- | --------------------- | ------- | ----------- | -------------------------- |
| AI Free        | Free monthly          | $0.00   | every month | Free plan × Monthly        |
| AI Pro         | Pro monthly           | $20.00  | every month | Pro plan × Monthly         |
| AI Pro         | Pro annual            | $200.00 | every year  | Pro plan × Annual          |
| AI Credits     | 100 credit add-on     | $10.00  | one-time    | `credits-100` add-on SKU   |
| AI Credits     | 500 credit add-on     | $40.00  | one-time    | `credits-500` add-on SKU   |

With the CLI:

```bash
# --- AI Free ---
stripe products create --name "AI Free"
stripe prices create --product prod_XXX --unit-amount 0 --currency usd \
  --recurring.interval month

# --- AI Pro ---
stripe products create --name "AI Pro"
stripe prices create --product prod_YYY --unit-amount 2000 --currency usd \
  --recurring.interval month
stripe prices create --product prod_YYY --unit-amount 20000 --currency usd \
  --recurring.interval year

# --- AI Credits (one-time) ---
stripe products create --name "AI Credits"
stripe prices create --product prod_ZZZ --unit-amount 1000 --currency usd
stripe prices create --product prod_ZZZ --unit-amount 4000 --currency usd
```

Substitute each `prod_...` with the identifier the preceding command returned.
Note that the add-on prices are created **without** `--recurring.*`: an add-on
is a one-time charge and must never appear as a subscribable option.

### Why Free is a real $0 Price

Free is a genuine Stripe Subscription on a zero-amount recurring Price, not a
local-only sentinel. Two consequences worth knowing before you wonder about
them:

- A $0 subscription needs **no payment method**, so the Free plan still costs
  the user nothing and collects nothing.
- It emits a **zero-amount invoice every month**, which Stripe marks paid. That
  invoice is what allocates Free's monthly credits, along the same code path
  Pro Monthly's renewal uses.

## 3. Record the identifiers

Copy each `price_...` identifier into `.env` (see `.env.example`):

```bash
STRIPE_PRICE_AI_FREE_MONTHLY=price_...
STRIPE_PRICE_AI_PRO_MONTHLY=price_...
STRIPE_PRICE_AI_PRO_ANNUAL=price_...
STRIPE_PRICE_AI_ADDON_100=price_...
STRIPE_PRICE_AI_ADDON_500=price_...
```

## 4. Seed the catalog

```bash
npm run db:up          # PostgreSQL
npx prisma migrate deploy
npx prisma db seed
```

The seed upserts on natural keys, so it is safe to re-run — including after you
replace a Stripe Price identifier, which updates the existing catalog row rather
than creating a second one.

## 5. Verify

```bash
docker exec billing-service-postgres psql -U billing -d billing -c \
  "SELECT p.key, p.credits_per_period, p.credit_period_interval,
          po.billing_interval, po.unit_amount, po.stripe_price_id
     FROM plans p JOIN pricing_options po ON po.plan_id = p.id
    ORDER BY p.key, po.billing_interval;"
```

Pro Annual should show `billing_interval = YEAR` alongside
`credit_period_interval = MONTH` and `credits_per_period = 100`. That is not a
mistake: annual billing does not release a year of credits at once — the plan
grants 100 credits per *monthly* credit period on both cycles.

## 6. Webhooks

Nothing in this service happens until Stripe tells it something happened. A paid
subscription, a paid add-on, a failed renewal, a cancellation — every one of
them reaches the service as a webhook delivery and by no other route. **If
Stripe is not delivering, the service looks healthy and silently does nothing:
customers are charged and get neither their subscription nor their credits.**

### Local development

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

This opens a connection *outward* from your machine, so no public URL is needed.
Put the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET` in `.env`.

It only lives as long as the command runs. It registers nothing at Stripe, so it
is not a substitute for the step below — checking the dashboard after using it
shows no endpoint, which is expected rather than a fault.

### Deployed environments — required, and easy to forget

Registering the handler in code achieves nothing if Stripe is not sending the
event. Do this **once per environment**, against that environment's own Stripe
account and its own public HTTPS URL:

```bash
stripe webhook_endpoints create \
  --url https://YOUR-HOST/webhooks/stripe \
  --api-version 2026-06-24.dahlia \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=invoice.paid" \
  -d "enabled_events[]=invoice.payment_failed" \
  -d "enabled_events[]=payment_method.attached" \
  -d "enabled_events[]=payment_method.detached" \
  -d "enabled_events[]=payment_method.updated"
```

Then put the endpoint's own signing secret — not the CLI's — into that
environment's `STRIPE_WEBHOOK_SECRET`.

Three things about that command are deliberate:

- **The eight event types are exactly the set the code acts upon.** They are
  asserted against `HANDLED_EVENT_TYPES` by `webhook-boundaries.spec.ts`, so
  that list and this one move together. An event subscribed here but not handled
  is answered `200 unhandled` and is merely noise; an event handled but *not*
  subscribed is a silent hole.
- **`--api-version` is not optional.** A webhook endpoint carries its own API
  version, and one created without this inherits the *account* default — which
  is not necessarily the version the adapter was written against. Pin it to the
  same literal as `stripe-billing.provider.ts`.
- **The URL must be publicly reachable over HTTPS.** Stripe calls in; `localhost`
  and private addresses cannot work. This is the reason the step cannot be done
  before a deployment exists.

Verify afterwards:

```bash
stripe webhook_endpoints list
```

An empty list means no endpoint is registered and no event is being delivered.
