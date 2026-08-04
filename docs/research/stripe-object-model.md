# Research: Stripe Object Model and Webhook Semantics

**Ticket:** `docs/wayfinder/tickets/003-research-stripe-object-model.md`
**Date:** 2026-08-04
**Sources:** Stripe official documentation (`docs.stripe.com`) unless explicitly marked otherwise.

## API version this research reflects

Stripe's current API version at time of writing is **`2026-07-29.dahlia`**
([API versioning](https://docs.stripe.com/api/versioning)). All API reference pages cited below were
read at their unpinned (latest) URLs, so field shapes described here are the **dahlia** shapes.

Two Basil-era breaking changes (API version `2025-03-31.basil`) are still in force and are the single
biggest source of stale advice on the internet:

1. `Subscription.current_period_start` / `current_period_end` were **removed** from the Subscription
   object and moved onto **subscription items**.
2. `Invoice.subscription` and `Invoice.payment_intent` were **restructured** into `Invoice.parent`
   and `Invoice.confirmation_secret` / `Invoice.payments`.

Both are detailed in sections 5 and 1 respectively.

> **Important operational note:** the API version that shapes a *webhook payload* is the account's
> default API version (or the version pinned on the webhook endpoint), **not** the version your SDK
> uses. Stripe recommends pinning the webhook endpoint's API version to match the version pinned by
> your SDK (`stripe-node` v12+). Source: [API versioning](https://docs.stripe.com/api/versioning).
> **Decision required:** we must pin explicitly, otherwise a Stripe-side account default change can
> silently reshape our webhook payloads in production.

---

## Summary

- The domain's `Subscription`, `PaymentTransaction`, `PaymentMethod` and `Customer` map cleanly onto
  Stripe's `Subscription`, `PaymentIntent`/`Charge`/`Invoice`, `PaymentMethod` and `Customer` — but
  `PaymentTransaction` is a *projection* over several Stripe objects, not a 1:1 mapping.
- Stripe has **8 subscription statuses**; the domain has **4**. Three Stripe statuses
  (`incomplete`, `incomplete_expired`, `unpaid`) and arguably `paused` have **no home** in the domain
  model, and the domain's `expired` has **no Stripe equivalent at all** — it is a purely local state.
- Stripe guarantees **at-least-once** delivery and explicitly **does not guarantee ordering**.
  Every handler must be idempotent by `event.id` and must tolerate out-of-order arrival.
- `invoice.paid` **does** fire for the first invoice as well as renewals. `billing_reason`
  distinguishes them (`subscription_create` vs `subscription_cycle` vs `subscription_update`).
  Our credit-allocation logic must branch on `billing_reason` or it will double-allocate on
  mid-cycle plan changes.
- `current_period_end` is **no longer on the Subscription object**. The annual cron must read
  `subscription.items.data[i].current_period_end`.
- Stripe does **not** issue automatic refunds on downgrade. It issues **proration credits** — negative
  invoice line items and customer balance credits. Requirements §"Payment Transaction" describes these
  as "refunds ... recorded as transactions with a negative amount", which does not match Stripe's model.
- Test clocks are the only way to test multi-month lifecycles without waiting, but they are
  **sandbox-only**, capped at **two billing intervals per advance**, limited to **3 customers /
  3 subscriptions per customer**, auto-deleted after **30 days**, and they **cannot simulate payment
  failures during advancement**.

---

## 1. Object mapping

### 1.1 Domain `Customer` → Stripe `Customer`

Object: [`customer`](https://docs.stripe.com/api/customers/object)

| Field | Notes |
|---|---|
| `id` (`cus_…`) | Store as the billing identity mapping on our `User`. |
| `email`, `name`, `phone`, `address` | Optional profile data. |
| `metadata` | Where we should stamp our own `userId`. |
| `invoice_settings.default_payment_method` | The payment method Stripe uses for subscriptions/invoices. This — not `Subscription.default_payment_method` — is the account-level default. |
| `default_source` | Legacy (Sources/Cards API). Do not use for new integrations. |
| `balance` | **Signed** invoice credit balance. **Negative = credit to apply to the next invoice; positive = amount owed.** Proration credits land here. |
| `invoice_credit_balance` | Multi-currency variant of `balance`. |
| `delinquent` | Boolean tracking the most recent state change on the customer's invoices. |
| `test_clock` | Non-null when the customer belongs to a test clock. |
| `livemode` | `false` in test mode / sandboxes. |

The requirements' rule "each User has exactly one corresponding Stripe Customer" is enforceable only
by us — Stripe places no uniqueness constraint on `email`, so duplicate Customers are trivially
creatable. Use an idempotency key or a unique constraint on our side.

### 1.2 Domain `Subscription` → Stripe `Subscription`

Object: [`subscription`](https://docs.stripe.com/api/subscriptions/object)

| Field | Notes |
|---|---|
| `id` (`sub_…`) | |
| `customer` | Expandable reference to `cus_…`. |
| `status` | 8 possible values — see section 2. |
| `items` (list of `SubscriptionItem`) | **Carries the billing period** (`current_period_start`, `current_period_end`) since Basil. Also carries `price` and `quantity`. |
| `billing_cycle_anchor` | Reference point for future billing cycle dates. |
| `start_date` | When the subscription was first created. |
| `cancel_at_period_end` | Boolean. `true` = will cancel at period end; **status stays `active`**. |
| `cancel_at` | Timestamp of scheduled automatic cancellation. |
| `canceled_at` | When cancellation was *requested*. |
| `ended_at` | When the subscription actually ended. |
| `latest_invoice` | Expandable reference to the most recent invoice. |
| `default_payment_method` | Subscription-level override of the customer default. |
| `collection_method` | `charge_automatically` \| `send_invoice`. |
| `trial_start` / `trial_end` / `trial_settings` | Out of scope for us (requirements §11 excludes trials) but `trial_settings.end_behavior.missing_payment_method` is what produces `paused`. |
| `pause_collection` | Object with `behavior` ∈ `keep_as_draft` \| `mark_uncollectible` \| `void`. **Does not set `status = paused`** — see section 2. |
| `metadata` | Where we should stamp our `userId` / internal subscription id. |
| `test_clock` | Non-null when under a test clock. |

**Mapping caveat:** our domain model says "A User has exactly one current Subscription at any time",
and models a Pro→Free downgrade as *expiring* the Pro row and *creating* a new Free row. Stripe has no
notion of a "Free subscription row" unless we actually create a Stripe Subscription against a
zero-amount Price. See "Implications" for the two options and their consequences.

### 1.3 Domain `PaymentMethod` → Stripe `PaymentMethod`

Object: [`payment_method`](https://docs.stripe.com/api/payment_methods/object)

| Field | Notes |
|---|---|
| `id` (`pm_…`) | The only reference we should persist. |
| `type` | Large enum (`card`, `link`, `paypal`, `us_bank_account`, `sepa_debit`, …). We will likely restrict to `card` initially. |
| `customer` | Non-null ⇒ attached; `null` ⇒ detached. |
| `card.brand` / `card.last4` / `card.exp_month` / `card.exp_year` / `card.funding` | Safe display metadata. |
| `card.fingerprint` | Stable identifier for the same physical card across Customers — useful for abuse detection, but it is card-derived data; treat carefully. |
| `billing_details` | Name/email/address/phone. |
| `allow_redisplay` | `always` \| `limited` \| `unspecified`. |
| `created`, `metadata` | |

This satisfies the requirement "the Billing Service only stores references and billing-related
metadata" — `last4`/`brand`/`exp_*` are explicitly non-sensitive display fields returned by the API.

### 1.4 Domain `PaymentTransaction` → **no single Stripe object**

This is the mapping that requires a decision. Stripe splits a "money event" across three objects:

| Stripe object | Role |
|---|---|
| [`Invoice`](https://docs.stripe.com/api/invoices/object) | The *billing document* for subscription charges. Carries `amount_due`, `amount_paid`, `amount_remaining`, `total`, `status` (`draft`\|`open`\|`paid`\|`uncollectible`\|`void`), `billing_reason`, `period_start`/`period_end`, `attempt_count`, `next_payment_attempt`, `hosted_invoice_url`, `lines`. |
| [`PaymentIntent`](https://docs.stripe.com/api/payment_intents/object) | The *payment workflow*. `id` (`pi_…`), `amount`, `amount_received`, `currency`, `customer`, `payment_method`, `latest_charge`, `status` ∈ `requires_payment_method` \| `requires_confirmation` \| `requires_action` \| `processing` \| `succeeded` \| `canceled`, `last_payment_error`. |
| `Charge` | The *actual money movement*, reachable via `PaymentIntent.latest_charge`. Refunds are applied against Charges. |
| [`Refund`](https://docs.stripe.com/api/refunds/object) | `id`, `amount` (**always a positive integer**), `charge`, `payment_intent`, `status` ∈ `pending`\|`requires_action`\|`succeeded`\|`failed`\|`canceled`, `reason`, `currency`. |

**Basil+ shape change on Invoice** — this breaks most pre-2025 examples:

- `Invoice.subscription` no longer exists at the top level. The subscription is now at
  `invoice.parent.subscription_details.subscription`, with `invoice.parent.type ===
  "subscription_details"`.
  ([Invoicing resources now specify how they were generated](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects))
- `Invoice.payment_intent` no longer exists at the top level. There is now
  `invoice.confirmation_secret` (`{ client_secret, type }`) and an expandable `invoice.payments` list,
  where each entry has `payment.type` ∈ `charge` \| `payment_intent` \| `payment_record` plus the
  corresponding id.
- Invoice line items also gained `lines.data[].parent` with
  `parent.subscription_item_details.subscription`.

**For add-on credit purchases** (one-time payments, requirements §7), the relevant object is a
standalone `PaymentIntent` (or a Checkout Session that produces one) — there is no Invoice involved
unless we deliberately invoice it. The two paths therefore produce structurally different payloads and
our `PaymentTransaction` writer needs two adapters, not one.

---

## 2. Status vocabulary mismatch

Source: [How subscriptions work](https://docs.stripe.com/billing/subscriptions/overview) and
[the Subscription object](https://docs.stripe.com/api/subscriptions/object).

### 2.1 Stripe's eight statuses

| Stripe status | Meaning | What triggers it |
|---|---|---|
| `incomplete` | The subscription was created but the **first** payment has not succeeded. The customer has **23 hours** to pay the initial invoice. Also occurs while a PaymentIntent is `processing`, or when 3DS authentication is required (`requires_action`). | Subscription created with an immediate charge that did not immediately succeed; `payment_behavior=default_incomplete`. |
| `incomplete_expired` | **Terminal.** The initial payment was never completed within 23 hours. The subscription never billed the customer. | 23-hour window elapses while `incomplete`. Cannot be reactivated — you must create a new subscription. |
| `trialing` | In a trial period; first charge is deferred. Safe to provision. | Subscription created with `trial_end`/`trial_period_days`. |
| `active` | Good standing. **Caveat from Stripe's own docs: `active` does *not* guarantee all outstanding invoices are paid — only that the *latest finalized* invoice was paid.** | Successful initial payment, trial end with successful payment, or payment of the latest invoice while `past_due`. |
| `past_due` | Payment on the latest *finalized* invoice failed or was not attempted. The subscription **keeps generating invoices**. Smart Retries run. | Failed renewal charge. |
| `unpaid` | Smart Retries are exhausted and no further payment attempts will occur. The latest invoice stays `open`. **Invoices keep being generated for future periods.** Stripe explicitly says: revoke access. | Configured behaviour after retries exhaust (Dashboard → Billing → Automatic collection settings). |
| `canceled` | **Terminal.** `auto_advance=false` on unpaid invoices; only `metadata` and `cancellation_details` remain mutable. To resubscribe you must create a *new* subscription. | Explicit cancellation (immediate), scheduled `cancel_at`, `cancel_at_period_end` reaching period end, or configured post-retry behaviour. |
| `paused` | No new invoices are created. | **Only** when a trial ends with no default payment method **and** `trial_settings.end_behavior.missing_payment_method = pause`. |

Two subtleties that are easy to get wrong:

- **`cancel_at_period_end = true` does NOT change the status.** The subscription stays `active`
  (or `trialing`) until the period actually ends, at which point it flips to `canceled` and
  `customer.subscription.deleted` fires.
  ([Cancel subscriptions](https://docs.stripe.com/billing/subscriptions/cancel),
  [Cancel a subscription API](https://docs.stripe.com/api/subscriptions/cancel))
- **`pause_collection` is not the `paused` status.** Pausing *payment collection* keeps the
  subscription's status as-is (customer retains access) and only stops collection; the `paused`
  *status* comes solely from the trial-end-without-payment-method path. Stripe distinguishes these
  via `status_details.paused.subscription.type` (`pause_requested` vs
  `trial_end_without_payment_method`).
  ([Pause payment collection](https://docs.stripe.com/billing/subscriptions/pause))
- Whether `past_due` becomes `canceled`, `unpaid`, or stays `past_due` after Smart Retries exhaust is
  a **Dashboard setting**, not an API parameter. This is account-wide configuration that our code
  cannot read from a webhook payload. **Decision required:** we must pick one and document it, because
  the domain's `expired` semantics depend on it.

### 2.2 Mapping onto our four states

| Stripe status | Domain state | Verdict |
|---|---|---|
| `active` | `active` | Clean. |
| `past_due` | `past-due` | Clean. |
| `canceled` | `canceled` **or** `expired`? | **Ambiguous — see below.** |
| `trialing` | — | Not applicable; trials are out of scope (requirements §11). If a trial is ever enabled, this status has no home. |
| `incomplete` | — | **No home.** |
| `incomplete_expired` | — | **No home.** |
| `unpaid` | — | **No home.** |
| `paused` | — | **No home** (only reachable via trials, currently out of scope). |
| — | `expired` | **No Stripe equivalent.** `expired` is a purely local state. |

**The `canceled` / `expired` collision is the sharpest problem.** Our domain distinguishes:

- `canceled` = user has requested non-renewal, access continues to period end. In Stripe this is
  `status = active` **plus** `cancel_at_period_end = true`. It is *not* Stripe's `canceled`.
- `expired` = the period has ended and will not renew. In Stripe this is `status = canceled` with
  `ended_at` set, signalled by `customer.subscription.deleted`.

So the naive mapping "Stripe `canceled` → domain `canceled`" is **wrong** and would mark a
subscription canceled a full billing period too late (or expire it a period too early, depending on
direction). The correct derivation is:

```
domain.canceled  ⟸  stripe.status ∈ {active, trialing} AND stripe.cancel_at_period_end === true
domain.expired   ⟸  stripe.status === "canceled"   (i.e. customer.subscription.deleted)
```

**Gaps with no home (must be decided, not ignored):**

1. **`incomplete`** — a Pro checkout where the card requires 3DS and the user walks away. We would have
   no local state to represent "subscription created in Stripe but not yet paid". If we treat it as
   `active`, we grant 200 credits for an unpaid subscription. If we ignore
   `customer.subscription.created` for `incomplete` subscriptions, we have a Stripe object with no
   local row for up to 23 hours.
2. **`incomplete_expired`** — terminal; the local row (if created) is orphaned forever. Nothing maps
   to it. Probably wants to fold into `expired`, but that conflicts with "expired = period ended
   after having been paid" and would pollute Billing History.
3. **`unpaid`** — semantically "dunning gave up, revoke access", which is closest to `expired`, but
   unlike `expired` the subscription **keeps generating invoices** and can return to `active` if the
   customer pays. Folding it into `expired` (a terminal-sounding state) is lossy. Folding it into
   `past-due` (which freezes the wallet) is arguably more faithful to behaviour but misrepresents
   Stripe's state and means we never stop retrying locally.
4. **`paused`** — unreachable while trials are out of scope, but will become reachable the moment
   trials are introduced (requirements §11 lists trials as "not included *initially*").

---

## 3. Webhook event semantics

Sources: [Webhooks](https://docs.stripe.com/webhooks),
[Webhook best practices](https://docs.stripe.com/webhooks/best-practices),
[Event types](https://docs.stripe.com/api/events/types),
[Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks),
[Event destinations](https://docs.stripe.com/event-destinations).

### 3.1 Delivery guarantees — the load-bearing part

| Property | Stripe's guarantee |
|---|---|
| **Delivery** | **At-least-once.** Stripe's docs: *"Webhook endpoints might occasionally receive the same event more than once."* There is no exactly-once mode. |
| **Duplicates** | **Expected, not exceptional.** Recommended defence: log processed `event.id` values and skip already-logged ones. Where duplicates arrive as *distinct* Event objects (i.e. different `event.id` for the same underlying change), Stripe recommends deduplicating on the pair (`data.object.id`, `event.type`). |
| **Ordering** | **Not guaranteed.** Stripe's docs state plainly: *"Stripe doesn't guarantee the delivery of events in the order that they're generated."* Their own example is subscription creation producing `customer.subscription.created`, `invoice.created`, `invoice.paid`, `charge.created` — which may arrive in any order. Recommended defence: on receiving an event, **fetch the current object from the API** rather than trusting the payload's implied sequence. |
| **Retries (live mode)** | Up to **3 days** with exponential backoff on any non-2xx (or timeout). |
| **Retries (sandbox)** | **3 attempts over a few hours.** |
| **Manual resend** | Dashboard: up to **15 days** after event creation. CLI (`stripe events resend <id> --webhook-endpoint=<ep>`): up to **30 days**. A manual resend that returns 2xx **does not** dismiss the automatic retry schedule. |
| **Expected response** | Any `2xx`. Anything else counts as a delivery failure. |
| **Handler timeout** | **Unconfirmed.** Stripe's docs repeatedly say to *"quickly return a successful status code (2xx) prior to any complex logic that could cause a timeout"* and show a `(Timed out) ERR` failure state, but **do not publish a numeric timeout in seconds** on the pages read. Do not design against a specific number; design to ack immediately. |
| **Endpoint auto-disable** | **Unconfirmed.** Not documented on the webhooks, best-practices, or event-destinations pages read. |
| **Event retention** | Dashboard Events tab: **13 months**. Full payload + delivery attempts: **< 15 days**. Full payload without resend: **16–30 days**. Summary only: **> 30 days**. **Retrieve/List Events API: past 30 days only.** |
| **Destination limit** | **16 event destinations** per livemode or sandbox account. |

This directly validates the requirements' design (persist raw event → return 2xx → process async →
idempotency by Stripe event ID → retry queue → DLQ). The one addition Stripe's docs force:
**ordering-independence**, which the requirements do not currently mention.

### 3.2 Event object shape

```jsonc
{
  "id": "evt_…",              // deduplication key
  "object": "event",
  "type": "invoice.paid",
  "api_version": "2026-07-29.dahlia",  // version that shaped THIS payload
  "created": 1234567890,
  "livemode": false,
  "data": {
    "object": { /* full snapshot of the affected resource */ },
    "previous_attributes": { /* only on *.updated events; old values of changed fields */ }
  },
  "request": { "id": "req_…", "idempotency_key": null }
}
```

These are **snapshot events** (API v1) — `data.object` contains the full object. (Stripe's newer
**thin events**, API v2 / Clover+, contain minimal data and require `fetch_related_object()`; the
eight events we care about are all v1 snapshot events.)

`data.previous_attributes` is what lets us tell *what changed* on an update — e.g. old `status`, old
`items`, old `cancel_at_period_end`. **It is only populated on `*.updated` events**, and it contains
only the changed fields.

### 3.3 The eight events

#### `customer.created` / `customer.updated`

| | |
|---|---|
| **Trigger** | `created`: a new Customer is created. `updated`: *"whenever any property of a customer changes."* |
| **Payload** | `data.object` = full [`customer`](https://docs.stripe.com/api/customers/object) object. `customer.updated` also carries `previous_attributes`. |
| **NOT guaranteed** | `customer.updated` is **extremely chatty** — it fires on *any* property change, including `balance` changes from proration credits, `default_source`, `invoice_settings`, `delinquent`, and metadata. Do not treat it as a "profile edited" signal. There is no filter for *which* property changed other than inspecting `previous_attributes`. |

#### `payment_method.attached` / `payment_method.detached`

| | |
|---|---|
| **Trigger** | `attached`: a payment method is attached to a customer. `detached`: a payment method is detached from a customer. |
| **Payload** | `data.object` = full [`payment_method`](https://docs.stripe.com/api/payment_methods/object) object. |
| **NOT guaranteed** | On `payment_method.detached`, the `customer` field is `null` in the payload — **the payload does not tell you which customer it was detached from**. If we only key our local `PaymentMethod` rows by Stripe customer id, a detach event cannot be resolved. **We must store `pm_…` → our user id locally** so detach is resolvable. *(This follows from the documented semantics that `customer` is non-null when attached and null when detached; I could not find a Stripe page that states the detach payload's `customer` value explicitly — treat as **high-confidence inference, verify with `stripe trigger payment_method.detached`**.)* |
| **Also note** | There is a third event, `payment_method.updated`, which fires only on explicit PaymentMethod update API calls. Card auto-updates (network updater) are **not** covered by the requirements' event list. |

#### `invoice.paid` / `invoice.payment_failed`

| | |
|---|---|
| **`invoice.paid` trigger** | *"Occurs whenever an invoice payment attempt succeeds **or an invoice is marked as paid out-of-band**."* |
| **`invoice.payment_failed` trigger** | *"Occurs whenever an invoice payment attempt fails, due to either a declined payment, **including soft decline**, or to the lack of a stored payment method."* |
| **Payload** | `data.object` = full [`invoice`](https://docs.stripe.com/api/invoices/object) object — including `billing_reason`, `amount_paid`, `period_start`/`period_end`, `parent.subscription_details.subscription`, `lines`, `attempt_count`, `next_payment_attempt`. |
| **NOT guaranteed** | (a) `invoice.paid` also fires for **$0 and below-minimum-charge invoices**, which Stripe *auto-marks paid* and moves the amount to the customer's invoice balance — no money moved. (b) `invoice.payment_failed` fires **once per failed attempt**, so Smart Retries produce **multiple** such events for one invoice; `attempt_count` disambiguates. (c) `invoice.paid` may arrive **before** the corresponding `customer.subscription.updated` that flips the status to `active`. |
| **Related event** | `invoice.payment_succeeded` also exists and is described as *"Occurs whenever an invoice payment attempt succeeds."* It overlaps heavily with `invoice.paid`; the difference is that `invoice.paid` **additionally** covers out-of-band / marked-paid invoices. **Subscribe to `invoice.paid`, not both**, or you will double-process. |

#### `customer.subscription.created` / `updated` / `deleted`

| | |
|---|---|
| **`created` trigger** | *"Occurs whenever a customer is signed up for a new plan."* **The status in the payload may be `incomplete`** if authentication is required or `payment_behavior=default_incomplete`. |
| **`updated` trigger** | *"Occurs whenever a subscription changes (e.g., switching from one plan to another, or changing the status from trial to active)."* Also fires on: renewal, `cancel_at_period_end` being set, coupon/discount changes, quantity changes, metadata changes, and status transitions such as `active → past_due`. |
| **`deleted` trigger** | *"Occurs whenever a customer's subscription ends."* Fires **immediately** on a direct cancel, or **at the end of the billing period** when `cancel_at_period_end = true`. |
| **Payload** | `data.object` = full [`subscription`](https://docs.stripe.com/api/subscriptions/object) object. `updated` also carries `previous_attributes` — Stripe's own migration guidance is to inspect `previous_attributes.items.data[].price` to detect price/quantity changes. |
| **NOT guaranteed** | (a) `customer.subscription.updated` gives **no typed reason** for the change — you must diff `previous_attributes`. A plan change, a renewal, and a metadata tweak are the same event type. (b) `customer.subscription.created` does **not** mean the subscription is paid or active. (c) There is **no event for "the period rolled over"** other than `customer.subscription.updated` + the `invoice.*` chain. (d) `paused`/`resumed` have their own events (`customer.subscription.paused`, `customer.subscription.resumed`) which are **not in our subscribed set**; if trials are ever enabled we would miss them. |

### 3.4 Documented ordering for subscription creation

From [Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks), the *generated*
order (not the *delivered* order) is:

```
customer.subscription.created
  → invoice.created
  → invoice.finalized
  → invoice.paid  |  invoice.payment_failed  |  invoice.payment_action_required
```

**Critical operational trap:** if Stripe does not receive a successful response to `invoice.created`,
**invoice finalization is delayed for up to 72 hours** — for *all* configured endpoints. Our
"persist-then-2xx" design protects us here, but only if we actually return 2xx for event types we do
not care about, rather than erroring on unknown types.

---

## 4. `invoice.paid` specifics

### Does it fire for the first invoice as well as renewals?

**Yes.** Sources: [Subscription invoices](https://docs.stripe.com/billing/invoices/subscription),
[Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).

- **First invoice**: created immediately when the subscription is created. With
  `collection_method=charge_automatically` it is finalized immediately and charged. On success →
  `invoice.paid`.
- **Renewal invoice**: created automatically at each cycle boundary, left in `draft` for **~1 hour**
  (during which `invoice.created` has fired and items are still editable), then finalized and
  charged. On success → `invoice.paid`.

### How to distinguish initial / renewal / proration

The field is **`invoice.billing_reason`**. Full enum from
[the Invoice object](https://docs.stripe.com/api/invoices/object):

| `billing_reason` | Meaning | Relevance to us |
|---|---|---|
| `subscription_create` | First invoice for a newly created subscription. | **Allocate initial period credits.** |
| `subscription_cycle` | Subscription advanced into a new billing period (a renewal). | **Allocate renewal credits (monthly plans).** |
| `subscription_update` | Subscription was updated mid-cycle (plan change with `proration_behavior=always_invoice`, quantity change, etc.). | **Do NOT blindly allocate a full month of credits** — this is a proration invoice, not a period rollover. |
| `subscription_threshold` | A billing threshold was reached (usage-based). | Not applicable (no usage billing). |
| `subscription` | **Legacy** value, pre-May-2018, with no distinction between updates/cycles/thresholds. | Should never appear on new accounts; guard against it anyway. |
| `manual` | Created via the invoice editor, unrelated to a subscription. | Ignore. |
| `upcoming` | Reserved for preview invoices (Create Preview API / `invoice.upcoming`). | Never arrives on `invoice.paid`. |
| `quote_accept` | A quote was accepted. | Not applicable. |
| `automatic_pending_invoice_item_invoice` | Auto-generated from pending invoice items. | Possible if we ever add invoice items; ignore for now. |

**Therefore the credit-allocation rule must be:**

```
allocate subscription credits ⟸ event.type === "invoice.paid"
                                AND invoice.billing_reason ∈ { "subscription_create", "subscription_cycle" }
                                AND invoice.parent?.subscription_details?.subscription is present
```

Neither the requirements nor `domain-model.md` mention `billing_reason` at all. As written
("credits are allocated when Stripe emits the `invoice.paid` event") the system would **over-allocate
on every mid-cycle plan change** that produces an immediately-invoiced proration.

A second discriminator worth persisting for reconciliation: `invoice.period_start` /
`invoice.period_end` (and the per-line `lines.data[].period`), which identify the service period the
invoice covers. Proration invoices cover a partial period.

---

## 5. Period boundaries — `current_period_end`

**This is a breaking change most integrations get wrong.**

Source: [Adds subscription item-level billing periods and removes subscription-level periods](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end)
(API version `2025-03-31.basil`), confirmed against the current
[Subscription object](https://docs.stripe.com/api/subscriptions/object) reference.

- `Subscription.current_period_start` and `Subscription.current_period_end` were **removed**.
- They now live on **subscription items**:
  `subscription.items.data[].current_period_start` / `subscription.items.data[].current_period_end`.
- Stripe's stated migration is to read `subscription.items.data[0].current_period_end`.
- Basil also added support for **mixed billing intervals on the same subscription** — which is *why*
  the period moved to the item level: different items can now have different periods.
  ([Adds support for mixed intervals](https://docs.stripe.com/changelog/basil/2025-07-30/support-mixed-intervals))

**Consequences for the annual credit cron** (requirements: *"The cron stops allocating credits once it
reaches the Subscription's `current_period_end`"*):

1. The field named in the requirements **does not exist** on the object named in the requirements.
   The requirements must be reworded.
2. Reading `items.data[0]` is safe **only** because our plans are single-item (one Price per
   subscription). This is an assumption we should record and assert on, not one we should silently
   rely on. If we ever add a second subscription item, `[0]` is arbitrary.
3. Stripe's changelog gives **no guidance** for computing a subscription-level period when items
   differ. If we ever need one, we would have to define it ourselves (e.g. `min` of item period ends
   for a conservative "stop allocating" boundary).
4. `invoice.period_end` / `lines.data[].period.end` on the paid invoice are an alternative source for
   the paid-through boundary and arrive in the webhook payload directly — likely more robust for the
   cron than re-fetching the subscription, since it records what was *actually paid for*.

Also relevant: `billing_cycle_anchor` on the Subscription is the reference point for future cycle
dates and can be reset (`billing_cycle_anchor=now`) during plan changes — see section 6.

---

## 6. Plan changes (Pro→Free, monthly→annual)

Sources: [Upgrade and downgrade subscriptions](https://docs.stripe.com/billing/subscriptions/upgrade-downgrade),
[Prorations](https://docs.stripe.com/billing/subscriptions/prorations),
[Change subscriptions](https://docs.stripe.com/billing/subscriptions/change),
[Customer invoice balance](https://docs.stripe.com/billing/customer/balance).

### 6.1 How a plan change is performed

You **replace the price on the existing subscription item**:

```
POST /v1/subscriptions/{id}
  items[0][id]={SUB_ITEM_ID}
  items[0][price]={NEW_PRICE_ID}
```

Stripe warns explicitly: **you must pass the subscription item id**, otherwise the new price is
*added* alongside the old one rather than replacing it — which would silently create a two-item
subscription and (per section 5) two different period boundaries.

### 6.2 Events emitted

The docs are thinner here than one would like. What is documented:

- **`customer.subscription.updated`** fires on the change, with `previous_attributes` carrying the old
  values. Stripe's own migration guidance is to inspect `previous_attributes.items.data[].price` to
  detect a price change.
- With `proration_behavior=always_invoice`, an invoice is generated immediately →
  **`invoice.created` → `invoice.finalized` → `invoice.paid` / `invoice.payment_failed`**, with
  `billing_reason = subscription_update`.
- With `proration_behavior=create_prorations` (the default), **no invoice is generated now**; the
  proration line items are attached to the **next** invoice, which will carry
  `billing_reason = subscription_cycle`.

**Unconfirmed:** the upgrade/downgrade page does not enumerate events; Stripe states only that
"standard events include `customer.subscription.updated`". I found no Stripe page giving a definitive,
exhaustive event sequence for a plan change. **Verify empirically with `stripe listen` + a test clock.**

### 6.3 Where proration credits and "negative amounts" actually appear

| Where | What |
|---|---|
| **Invoice line items** | Proration credits appear as **negative-amount line items** on an invoice, e.g. `{"amount": -166, "description": "Unused time on Silver plan after 01 Sep 2020", "proration": true}`. Debits (upgrades) are positive line items. |
| **`proration_details.credited_items`** | For `billing_mode=flexible` subscriptions, credit proration invoice items carry a `proration_details` object identifying which debit the credit applies to. |
| **`Customer.balance`** (invoice credit balance) | If the credit exceeds the invoice total, the invoice total can be **0 or negative** and the surplus lands on the customer's invoice balance. **Negative = credit.** |
| **`CustomerBalanceTransaction`** | Every change to the invoice balance is recorded as an **immutable** `CustomerBalanceTransaction` with `type` ∈ `adjustment`, `applied_to_invoice`, `credit_note`, `invoice_too_small`, `unapplied_from_invoice`. Only `adjustment` is creatable by us. |
| **`Refund`** | Only if we **explicitly** create one. |

### 6.4 The refund assumption in our requirements is wrong

Requirements §"Payment Transaction" says:

> *"Refunds initiated by Stripe (e.g., during subscription plan changes) are recorded as transactions
> with a negative amount."*

Stripe's documentation contradicts the premise. From
[Customer invoice balance](https://docs.stripe.com/billing/customer/balance): **Stripe does not issue
automatic refunds on downgrade.** From
[Upgrade and downgrade subscriptions](https://docs.stripe.com/billing/subscriptions/upgrade-downgrade):
*"unused time is credited through the proration system, not as separate refunds."*

So:

- There is **no Stripe-initiated `Refund` object** during a plan change.
- The negative amounts are **invoice line items** and **customer balance credits** — accounting
  artefacts, not money leaving Stripe.
- The `Refund` object's `amount` is always a **positive integer** anyway
  ([Refund object](https://docs.stripe.com/api/refunds/object)); the "negative" is a convention we
  would be imposing ourselves.
- Cancellation refunds *are* possible but are opt-in: `DELETE /v1/subscriptions/{id}` accepts
  `prorate=true` (generates a credit proration invoice item for unused time — still a credit, not a
  refund) and `invoice_now=true`. The Dashboard cancellation flow separately offers "refund a prorated
  amount / refund the last payment in full / no refund", and notes **you cannot refund if you set a
  custom cancellation date** ([Cancel subscriptions](https://docs.stripe.com/billing/subscriptions/cancel)).

### 6.5 Monthly → annual specifically

- Switching **between different intervals** moves the billing date to the date of the switch (unlike
  same-interval changes, which preserve billing dates).
- `billing_cycle_anchor=now` resets the billing period to today and charges immediately for the new
  plan.
- To avoid crediting unpaid invoices during an interval change, Stripe documents the combination
  `proration_behavior=none` + `billing_cycle_anchor=now`.
- **Pending updates** (`billing/subscriptions/pending-updates`) let the change apply *only if* the
  resulting invoice is paid — highly relevant for a paid upgrade, so we don't grant Pro credits on a
  failed card.

### 6.6 Pro → Free specifically

Stripe has no first-class "downgrade to free at period end". The documented options are:

- **Subscription schedules** — for changes at the end of a billing period, "to manage transitions
  cleanly and prevent unexpected overwrites".
- `cancel_at_period_end=true` on the Pro subscription, then create a Free subscription (or no Stripe
  subscription at all) on `customer.subscription.deleted`.

The second matches our domain model's described flow. **Note the timing risk:**
`customer.subscription.deleted` arrives at period end, out of order relative to any final
`invoice.paid`, and our handler creates a new Free row. If that event is retried (at-least-once), we
must be idempotent or we create duplicate Free subscriptions.

---

## 7. Webhook signature verification

Sources: [Webhooks](https://docs.stripe.com/webhooks),
[Resolve webhook signature verification errors](https://docs.stripe.com/webhooks/signature),
[Webhook best practices](https://docs.stripe.com/webhooks/best-practices),
[NestJS: Raw Body](https://docs.nestjs.com/faq/raw-body).

### 7.1 The header

```
Stripe-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=…
```

- `t` = timestamp (seconds)
- `v1` = HMAC-SHA256 signature — **the only valid scheme for live events**
- `v0` = a fake scheme present on test events; **ignore it**

Verification is: `signed_payload = "{t}.{raw_body}"`, `expected = HMAC_SHA256(endpoint_secret,
signed_payload)`, compared in **constant time** against every `v1` value present (there can be more
than one during secret rotation).

### 7.2 Signing secret

- Starts with `whsec_`.
- Dashboard/Workbench endpoints: Webhooks tab → "Reveal secret".
- Stripe CLI: printed by `stripe listen`.
- **These are different secrets.** Stripe explicitly warns: *"don't verify CLI-forwarded events with
  Dashboard secrets or vice versa."*
- Secrets can be **rolled**, with expiry deferrable up to 24 hours; multiple secrets stay active during
  the transition — so the verifier should accept a **list** of secrets, not one.

### 7.3 Tolerance window

- **Default tolerance: 5 minutes (300 seconds)** between the header timestamp and current time, in all
  official libraries. Configurable via an extra parameter.
- Stripe explicitly warns: **never set tolerance to `0`** — it disables the recency check entirely.
- Keep server clocks NTP-synced; clock drift manifests as spurious verification failures.

### 7.4 The raw-body requirement, and the NestJS pitfall

Stripe: *"Stripe requires the raw body of the request to perform signature verification. If you're
using a framework, make sure it doesn't manipulate the raw body. Any manipulation to the raw body of
the request causes the verification to fail."*

Documented forms of "manipulation" that break it:

- adding/removing whitespace
- reordering key-value pairs
- parsing to JSON and re-serialising
- changing the encoding (must remain UTF-8)

For Express, Stripe's documented fix is **ordering**: register the webhook route *before*
`app.use(express.json())`, or use `bodyParser.raw({ type: 'application/json' })` on that route only.

**This is exactly the NestJS trap.** NestJS enables a global body parser by default, so by the time a
`@Post()` handler runs, `req.body` is a parsed object and the original bytes are gone. Signature
verification then fails 100% of the time, for every event, in a way that looks like a bad secret.

NestJS's official answer ([docs.nestjs.com/faq/raw-body](https://docs.nestjs.com/faq/raw-body)):

```typescript
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  rawBody: true,
});
```

then

```typescript
@Post()
handle(@Req() req: RawBodyRequest<Request>) {
  const raw = req.rawBody; // Buffer
}
```

Caveats from the NestJS docs that bite here:

- **`rawBody: true` only works if the built-in global body parser is enabled** — do not also pass
  `bodyParser: false`.
- **Body size limits apply**: Express defaults to **100 kb**, Fastify to **1 MiB**. Adjust via
  `app.useBodyParser()`. Stripe payloads for subscriptions with many line items can be large; a
  silently-truncated or rejected body is another signature-failure mode.
- You must pass the correct app type (`NestExpressApplication` / `NestFastifyApplication`) to
  `NestFactory.create()` or `.useBodyParser()` won't exist.

Two more Stripe-documented practices worth wiring in:

- **Exempt the webhook route from CSRF protection.**
- **Combine signature verification with IP allowlisting** ([Stripe IPs](https://docs.stripe.com/ips)),
  and require HTTPS with TLS 1.2+ (mandatory in live mode).

---

## 8. Testing affordances

### 8.1 Test mode / sandboxes

- Every object carries `livemode: false`. Test and live data are fully separated, with separate API
  keys and separate webhook signing secrets.
- Stripe's [Automated testing](https://docs.stripe.com/automated-testing) page cautions that **Stripe
  APIs are rate limited** and that Stripe UI elements (Checkout, Payment Element) have security
  measures that block automated browser testing. Its recommendation is to **simulate API output with
  mock data** for most tests and hit the real test-mode API **infrequently**.

### 8.2 Stripe CLI

**`stripe listen`** ([Webhook quickstart](https://docs.stripe.com/webhooks/quickstart))

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
stripe listen --forward-to localhost:3000/webhooks/stripe --events invoice.paid,customer.subscription.updated
```

- Forwards **real account events** (test mode) to a local port — no tunnel needed.
- Prints a **session-scoped `whsec_` secret** that is *different* from any Dashboard endpoint secret.
- `--events` filters the forwarded types; `--skip-verify` bypasses TLS verification (not recommended).

**`stripe trigger`** ([CLI trigger](https://docs.stripe.com/cli/trigger))

```bash
stripe trigger invoice.paid
stripe trigger customer.subscription.updated
stripe trigger payment_method.attached --override payment_method:card.brand=visa
stripe trigger invoice.payment_succeeded --add payment_intent:customer=cus_123
```

- Supports **80+ event fixtures**, including all eight of our core events.
- Flags: `--add`, `--override`, `--remove`, `--edit`, `--skip`, `--stripe-account`.
- **Critical caveat, stated by Stripe:** *"Events are triggered by issuing HTTP requests against the
  Stripe API. Because of this, triggering events causes side effects: all necessary API objects will
  be created in the process."* So `stripe trigger` (a) creates **real test-mode objects** and (b)
  **fires cascading extra events** beyond the one you asked for. It is good for exercising a handler's
  parsing and signature path; it is **not** a way to construct a precise scenario.

### 8.3 `stripe-mock`

*(Secondary source: the [stripe/stripe-mock README on GitHub](https://github.com/stripe/stripe-mock).
It is Stripe's own repository, but it is not part of `docs.stripe.com`, and the
[Automated testing](https://docs.stripe.com/automated-testing) doc page does not mention it at all.)*

Documented limitations, per that README:

- **Stateless.** POST data is validated then completely ignored — never reflected in the response or
  any later request.
- **Locked to the latest API version**; no older versions.
- **Cannot test specific errors** — it returns a success response instead of the requested error.
- Polymorphic endpoints always return a single resource type.
- Stripe states it is *"meant for basic sanity checks"* and that they are **not planning** to add
  statefulness.

**Conclusion: `stripe-mock` is useless for our subscription lifecycle testing.** A stateless mock
cannot model "subscription renews, period advances, invoice paid". Its only value is asserting that
our SDK calls hit the right URL with the right params.

### 8.4 Test clocks — the answer to "months without waiting"

Sources: [Test clocks](https://docs.stripe.com/billing/testing/test-clocks),
[Simulate subscriptions](https://docs.stripe.com/billing/testing/test-clocks/simulate-subscriptions),
[API and advanced usage](https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage),
[Advance a test clock](https://docs.stripe.com/api/test_clocks/advance).

**Mechanism.** Create a test clock with a `frozen_time`; create a Customer *on* that clock; create
Subscriptions for that Customer. Then advance the clock:

```bash
POST /v1/test_helpers/test_clocks/{CLOCK_ID}/advance
  frozen_time=1680199613
```

Stripe generates all the billing objects and **fires all the real webhook events** as if that time had
actually elapsed — `customer.subscription.updated`, `invoice.created`, `invoice.paid`,
`invoice.payment_failed`, plus the clock's own `test_helpers.test_clock.advancing` /
`test_helpers.test_clock.ready`.

**Advancement is asynchronous.** The call returns immediately with `status: "advancing"`; you must
poll until `status: "ready"` before asserting. Statuses: `advancing`, `ready`, `internal_failure`.

**Hard limits (these shape our test design):**

| Limit | Value |
|---|---|
| Max advance per call, with subscriptions | **Two intervals of the shortest-interval subscription on the clock** |
| Max advance per call, no subscriptions | **Two years** from the frozen time |
| Direction | **Forward only** after `frozen_time` is set (initial `frozen_time` may be past or future) |
| Customers per simulation | **3** |
| Subscriptions (incl. schedules) per customer | **3** |
| Quotes per simulation | **10** |
| Clock lifetime | **Auto-deleted 30 days after creation** |
| Invoice rate limit | **10 new invoices / subscription / minute**, **20 / subscription / day** |
| Quantity updates | **200 / subscription / hour** |
| Availability | **Sandbox / test mode only — not available in live mode** |

**Documented gotchas:**

- Test clocks **do not support** bank-debit collection (`us_bank_account`) and **cannot automatically
  fail payments during advancement** — *"Subscriptions enter `active` status even if payment would
  have failed."* To test dunning you must force failure another way (e.g. a declining test card
  attached before advancing) and watch `invoice.payment_failed` / `customer.subscription.deleted`.
- Objects created under a test clock are **omitted from unfiltered list endpoints**. `GET /v1/invoices`
  will not show them; you must pass `?customer=cus_…` or `?test_clock=clock_…`.
- Initial `frozen_time` **cannot be in the past** if you attach an *existing* customer.
- The account must have **no Automations** configured.
- A customer **cannot be removed** from a test clock once added.
- Deleting the clock deletes all associated test objects.

**Answering the ticket's specific question — can an annual subscription's year be simulated?**

Yes, but **not in one call**, and the "two intervals" limit is measured against the *shortest*
subscription on the clock:

- For an **annual** subscription alone, one advance can cover up to **2 years** — so a full annual
  period, its renewal, and its expiry are all reachable in **one or two advances**.
- The **20-invoices-per-subscription-per-day** rate limit is the real ceiling on long simulations, not
  the interval limit.
- **However** — and this is the crux for us — our **monthly credit allocation for annual plans is a
  local cron, not a Stripe event.** A test clock advances *Stripe's* clock; it does **not** advance our
  application's clock. So a test clock alone cannot exercise "12 monthly allocations across an annual
  period". We need an **injectable application clock** on our side, driven in lockstep with the Stripe
  test clock, to test that scenario at all.

  *(This is an inference from how test clocks are documented to work — they control Stripe-side
  billing time only. Stripe does not document anything about a consumer's own scheduler. Flagged as
  **inference, high confidence**.)*

- One further caution: if a Free plan is modelled as a real Stripe subscription at $0, mixing a
  monthly Free subscription and an annual Pro subscription **on the same clock** would drop the
  per-advance limit to **two months**, requiring ~6 advances to cover a year.

---

## Implications for our domain model

Ordered by how much they force a change.

### A. `current_period_end` does not exist where the requirements say it does — **blocking**

Requirements §"Subscription Credits": *"The cron stops allocating credits once it reaches the
Subscription's `current_period_end`."* That field was removed from the Subscription object in
`2025-03-31.basil`. The cron must read `subscription.items.data[0].current_period_end`, or better,
persist the paid-through boundary from `invoice.period_end` on the `invoice.paid` we already handle.

**Decisions forced:** (1) which source of truth for the boundary; (2) record and assert the
single-subscription-item assumption; (3) pin our webhook endpoint's API version explicitly.

### B. Stripe's `canceled` ≠ our `canceled` — **blocking, and easy to get silently wrong**

Our `canceled` ("won't renew, access continues") is Stripe's `active` + `cancel_at_period_end=true`.
Our `expired` is Stripe's `canceled`. A literal name-to-name mapping is off by one billing period.
`domain-model.md` says `expired` is *"triggered by Stripe webhook confirmation"* — correct, that's
`customer.subscription.deleted` — but it does not say how `canceled` is detected, and the obvious
guess is wrong.

### C. Three Stripe statuses have no home — **needs an explicit decision, not a default**

`incomplete`, `incomplete_expired`, `unpaid` (and `paused`, latent until trials arrive). Concrete
risks:

- **`incomplete`**: 3DS/SCA is mandatory in the EU. A Pro signup requiring authentication produces
  `customer.subscription.created` with `status: "incomplete"`. If we map "created ⇒ active" we grant
  200 credits for an unpaid subscription, and 23 hours later Stripe silently moves it to
  `incomplete_expired` with **no further subscription event guaranteed to tell us to revoke**.
- **`unpaid`**: Stripe's docs say revoke access. Our nearest state is `past-due` (which freezes the
  wallet — behaviourally right) or `expired` (which forfeits credits and spawns a Free subscription —
  arguably right, but irreversible, whereas Stripe's `unpaid` can return to `active`).
- The `past_due → canceled | unpaid | past_due` transition is governed by a **Dashboard setting** we
  cannot read at runtime. We must choose one, document it, and treat it as configuration drift risk.

Recommendation to the team: either widen the domain enum to carry `incomplete` and `unpaid`, or add an
explicit `stripeStatus` column alongside our own lifecycle state so nothing is lost in translation.
The current 4-value enum cannot round-trip Stripe's state.

### D. "Refunds initiated by Stripe during plan changes" do not exist — **requirements are factually wrong**

Requirements §"Payment Transaction" assumes Stripe issues refunds during plan changes and that we
record them as negative-amount transactions. Stripe's docs state the opposite: downgrades produce
**proration credits**, not refunds — negative invoice line items and `Customer.balance` credits, tracked
as `CustomerBalanceTransaction`s. A `Refund` object only exists if we explicitly create one, and its
`amount` is positive.

**Decisions forced:** (1) does `PaymentTransaction` model credits at all, or only actual money
movement? (2) if credits are modelled, they belong in a separate ledger mirroring
`CustomerBalanceTransaction`, not as negative payments; (3) refunds are listed as out of scope
(requirements §11) yet negative-amount refunds appear in §"Payment Transaction" — these two statements
contradict each other.

### E. `invoice.paid` alone is not a safe credit-allocation trigger — **blocking**

Both docs say "credits are allocated when Stripe emits `invoice.paid`". Neither mentions
`billing_reason`. Concrete failure modes:

1. **Over-allocation on plan change.** A mid-cycle upgrade with `proration_behavior=always_invoice`
   emits `invoice.paid` with `billing_reason=subscription_update` → a full extra month of credits.
2. **Over-allocation on duplicate delivery.** At-least-once delivery means the *same* `invoice.paid`
   can arrive twice. Idempotency by `event.id` (which the requirements do specify) covers exact
   duplicates, but not two *distinct* events for the same invoice — Stripe recommends deduplicating on
   (`data.object.id`, `event.type`) as well. **Our idempotency key should be the invoice id + billing
   period, not just the Stripe event id.**
3. **Zero-amount invoices.** Invoices below the currency minimum (including $0) are **auto-marked
   paid** and emit `invoice.paid` with no money moved. If Free plans are real Stripe subscriptions,
   Free credits ride on an event that represents no payment — workable, but it must be a deliberate
   choice, and a `PaymentTransaction` row for $0 is probably noise.

### F. Ordering-independence is missing from the requirements — **design gap**

Requirements §5 covers idempotency, retries, and DLQ, but says nothing about **out-of-order arrival**,
which Stripe explicitly does not guarantee. Real consequences:

- `invoice.paid` can arrive **before** the `customer.subscription.updated` that made the subscription
  `active` → we allocate credits against a subscription row that still says `past-due`, or against a
  row that doesn't exist yet.
- `customer.subscription.deleted` (Pro expiry) can arrive **before** a final `invoice.paid`.
- Stripe's documented mitigation is to **re-fetch the object from the API** on receipt rather than
  trusting the payload's implied sequence. Our "persist raw event, process async" design accommodates
  this, but the processor needs an explicit re-fetch or a version/sequence guard. Note
  `subscription.items.data[].current_period_end` is a natural monotonic guard.

The requirements' phrase *"processed atomically at the Subscription aggregate level"* is compatible
with this but does not by itself solve ordering.

### G. Free plan modelling is undecided, and it changes everything downstream — **needs a decision**

Requirements say a Stripe Customer is created when the initial Subscription (including Free) is
created, but never say whether a **Stripe Subscription** exists for Free. The two options diverge
sharply:

| | Free = real Stripe subscription at $0 | Free = local-only, no Stripe subscription |
|---|---|---|
| Monthly Free credits | Ride on `invoice.paid` (auto-paid $0 invoices) — **but see below** | Must be driven by our own cron |
| Period boundary | Comes from Stripe | We own it entirely |
| Test clock cost | Free monthly subs drop per-advance limit to 2 months | No impact |
| Pro→Free transition | Create a Stripe subscription on `customer.subscription.deleted` | Purely local |

**Unconfirmed and important:** Stripe documents that invoices below the minimum chargeable amount are
auto-marked paid, and separately that `invoice.paid` fires when *"an invoice is marked as paid
out-of-band"*. I could **not** find a Stripe page that states plainly whether a **$0 recurring price
reliably generates a monthly invoice and a monthly `invoice.paid`** for the whole life of the
subscription. Do **not** build Free-tier credit allocation on that assumption until it is verified
empirically with a test clock. This is the single most important thing to prototype.

### H. `payment_method.detached` may not identify the customer — **needs verification**

The `customer` field on a PaymentMethod is null once detached. If our local `PaymentMethod` rows are
keyed only by Stripe customer, a detach webhook is unresolvable. **Store `pm_…` → our user id
locally.** (High-confidence inference from the documented `customer` semantics; verify with
`stripe trigger payment_method.detached`.)

### I. `customer.updated` is far chattier than the requirements imply — **low severity**

It fires on *any* customer property change, including `balance` changes caused by proration credits.
Subscribing to it and treating it as "profile edited" will generate significant noise in the
`WebhookEvent` table and Billing History. Filter on `previous_attributes` or drop the subscription.

### J. Testing strategy consequences (feeds ticket 010)

1. **`stripe-mock` is not viable** for lifecycle tests — it is stateless by design and Stripe has
   stated they will not add statefulness.
2. **`stripe trigger` is not viable** for scenario tests — it creates real objects and fires cascading
   extra events. Use it only to smoke-test the signature/parse path.
3. **Test clocks are the only real option**, and they are **sandbox-only**, so lifecycle tests cannot
   run against a fully offline CI unless we mock at the HTTP boundary ourselves. They are also
   rate-limited (20 invoices/subscription/day) and auto-deleted after 30 days.
4. **Test clocks cannot fail payments during advancement** — dunning/`past-due` tests need a different
   mechanism (declining test cards set up before advancing).
5. **We need an injectable application clock.** The annual plan's monthly credit allocation is *our*
   cron, and a Stripe test clock does not move our scheduler. Without a clock abstraction on our side,
   requirements §"Subscription Credits" (catch-up allocation for missed months, stop at period end) is
   effectively untestable.
6. **`stripe listen`'s signing secret differs from the Dashboard's** — local dev config must not reuse
   the deployed secret, and the verifier should accept a **list** of secrets to survive rotation.

---

## Things I could not confirm

Listed plainly rather than guessed:

1. **Webhook handler timeout in seconds.** Stripe repeatedly warns about timeouts and shows a
   `(Timed out) ERR` state but publishes no number on the webhooks, best-practices, or
   event-destinations pages. Design to ack immediately rather than to a threshold.
2. **Automatic disabling of webhook endpoints after repeated failures.** Not documented on any page I
   read.
3. **Exhaustive event sequence for a plan change.** Stripe documents `customer.subscription.updated`
   and the proration invoice behaviour but gives no definitive ordered list. Must be observed
   empirically.
4. **Whether a $0 recurring price emits a monthly `invoice.paid` indefinitely.** See implication G.
   Load-bearing for the Free tier; verify before building on it.
5. **The `customer` field's exact value in a `payment_method.detached` payload.** Inferred, not
   documented on the pages read.
6. **Whether `customer_balance_transaction.created` is a real event type.** It did not appear in the
   event-types section I retrieved, and the customer-balance page does not list events. Do not rely on
   it without checking the full event type list.
7. **`billing_mode` (`classic` vs `flexible`) default for new accounts.** It materially changes
   proration credit amounts (Stripe's own example: `-$2.50` classic vs `-$4.17` flexible for the same
   downgrade). We should determine our account's mode before finalising any proration expectations.

---

## Source index

**API reference:**
[Subscription object](https://docs.stripe.com/api/subscriptions/object) ·
[Cancel a subscription](https://docs.stripe.com/api/subscriptions/cancel) ·
[Customer object](https://docs.stripe.com/api/customers/object) ·
[PaymentMethod object](https://docs.stripe.com/api/payment_methods/object) ·
[Invoice object](https://docs.stripe.com/api/invoices/object) ·
[PaymentIntent object](https://docs.stripe.com/api/payment_intents/object) ·
[Refund object](https://docs.stripe.com/api/refunds/object) ·
[Event types](https://docs.stripe.com/api/events/types) ·
[Advance a test clock](https://docs.stripe.com/api/test_clocks/advance) ·
[API versioning](https://docs.stripe.com/api/versioning)

**Billing guides:**
[How subscriptions work](https://docs.stripe.com/billing/subscriptions/overview) ·
[Subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks) ·
[Subscription invoices](https://docs.stripe.com/billing/invoices/subscription) ·
[Prorations](https://docs.stripe.com/billing/subscriptions/prorations) ·
[Upgrade and downgrade](https://docs.stripe.com/billing/subscriptions/upgrade-downgrade) ·
[Change subscriptions](https://docs.stripe.com/billing/subscriptions/change) ·
[Cancel subscriptions](https://docs.stripe.com/billing/subscriptions/cancel) ·
[Pause payment collection](https://docs.stripe.com/billing/subscriptions/pause) ·
[Customer invoice balance](https://docs.stripe.com/billing/customer/balance)

**Webhooks:**
[Receive Stripe events](https://docs.stripe.com/webhooks) ·
[Best practices](https://docs.stripe.com/webhooks/best-practices) ·
[Signature verification errors](https://docs.stripe.com/webhooks/signature) ·
[Webhook quickstart](https://docs.stripe.com/webhooks/quickstart) ·
[Event destinations](https://docs.stripe.com/event-destinations) ·
[Stripe IPs](https://docs.stripe.com/ips)

**Testing:**
[Test clocks](https://docs.stripe.com/billing/testing/test-clocks) ·
[Simulate subscriptions](https://docs.stripe.com/billing/testing/test-clocks/simulate-subscriptions) ·
[Test clock API and advanced usage](https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage) ·
[CLI trigger](https://docs.stripe.com/cli/trigger) ·
[Automated testing](https://docs.stripe.com/automated-testing)

**Changelog (Basil, `2025-03-31`):**
[Subscription item-level billing periods](https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end) ·
[New `parent` field on invoicing objects](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects) ·
[Mixed intervals support](https://docs.stripe.com/changelog/basil/2025-07-30/support-mixed-intervals)

**Non-Stripe primary source:**
[NestJS: Raw Body](https://docs.nestjs.com/faq/raw-body)

**Secondary source (marked as such in-text):**
[stripe/stripe-mock README (GitHub)](https://github.com/stripe/stripe-mock)
