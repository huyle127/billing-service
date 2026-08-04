# Billing Service Requirements

## 1. Overview

The Billing Service is responsible for managing user subscriptions, payments, credits, and billing history.

The service integrates with Stripe for payment processing and subscription management.

The system supports subscription-based access and credit-based usage.

---

## 2. Purpose

The purpose of the Billing Service is to provide a centralized system for:

- Managing user subscriptions.
- Processing subscription payments.
- Managing user payment methods.
- Managing user credits.
- Tracking billing and credit transactions.

---

## 3. Core Concepts

### User

A User represents a customer using the platform.

The Billing Service manages billing information for a User, including:

- Subscription.
- Credit wallet.
- Payment relationship.
- Billing history.

Each User has exactly one corresponding Stripe Customer for payment operations.

The Billing Service creates a Stripe Customer for every User, including users who never leave the Free plan. Free is a real Stripe subscription at a zero-amount recurring price, not local-only state.

### Provisioning a new user

Registration completes without contacting Stripe. In a single transaction the service creates the User, the Free Subscription, and the Credit Wallet with the Free plan's monthly credits already granted. The user can therefore reach a dashboard showing their plan and credit balance immediately, and registration does not fail when Stripe is unavailable.

The corresponding Stripe Customer and Stripe Subscription are provisioned **immediately afterwards, outside that transaction** — not deferred until the user next visits a billing page.

Provisioning is a single idempotent operation reached from three paths:

1. Invoked directly at the end of registration, without blocking the response.
2. Swept by a periodic reconciler, which finds current Subscriptions with no Stripe subscription recorded. The absent identifier is itself the work queue; no separate job table exists.
3. Invoked defensively before any operation that requires a Stripe Customer, such as upgrading or purchasing add-on credits.

A Subscription with no Stripe identifier is a valid intermediate state, not an error. The user retains full Free-tier access throughout it.

The initial credit grant made at registration and the grant that would follow the first zero-amount `invoice.paid` refer to the same subscription and the same month, so the allocation key described in §6 causes the second to be discarded.

The Billing Service owns the Stripe billing identity mapping. The upstream User Service owns the core user identity.

A User has exactly one current Subscription at any time.

---

### Subscription

A Subscription represents a User's current billing plan and lifecycle state.

Supported subscription plans:

- **Free**: 50 subscription credits per month.
- **Pro**: 200 subscription credits per month.

Supported billing cycles:

- **Monthly**: subscription is paid every month.
- **Annual**: subscription is paid once per year.

Subscription lifecycle states:

- **active**: the subscription is valid and will renew.
- **canceled**: the user has chosen not to renew; access and credits continue until the current period ends.
- **past-due**: a renewal payment has failed.
- **expired**: the subscription period has ended and will not renew.

#### Subscription state ownership

The four lifecycle states belong to the Billing Service. They are **set by this service**, not mirrored from Stripe's subscription status. Stripe events are inputs that trigger a transition; the state machine is ours, and no business rule branches on a Stripe status value.

The Subscription record additionally stores Stripe's raw status verbatim in a `stripeStatus` field. That field exists for reconciliation and audit only. It is never read to decide behaviour.

| Our state | Set by the Billing Service when | Stripe signal that informs it |
| --- | --- | --- |
| **active** | payment for the current period is confirmed | `invoice.paid` |
| **canceled** | the user requests non-renewal; access and credits continue to period end | `customer.subscription.updated` with `cancel_at_period_end = true` |
| **past-due** | a renewal payment has failed; the Credit Wallet is frozen | `invoice.payment_failed` |
| **expired** | the period has ended and will not renew; credits are forfeited and a Free Subscription is created | `customer.subscription.deleted` |

Because the state is ours, recovery from `past-due` is driven by observing a successful payment, not by Stripe returning the subscription to a particular status. This also means Stripe's own `past_due` transition behaviour — a Dashboard setting that cannot be read at runtime — does not silently alter our lifecycle. It should still be recorded during Stripe account setup so that reconciliation knows what to expect from the `stripeStatus` field.

Note that Stripe's vocabulary collides with ours without matching it. A subscription Stripe reports as `canceled` has **already ended**, which is our `expired`; our `canceled` is a subscription Stripe still reports as `active`. Reading Stripe's status as if it were ours is wrong by a full billing period, which is precisely why our state is set independently.

**A subscription pending payment authentication does not become current.** When a Pro signup requires 3DS/SCA, Stripe emits `customer.subscription.created` before any money moves. Treating that as activation would grant Pro credits for an unpaid subscription, and Stripe abandons it roughly 23 hours later without a guaranteed event instructing us to revoke. The Subscription row is recorded, but the User's **current** Subscription remains unchanged — typically Free — until payment is confirmed. This preserves the rule that a User has exactly one current Subscription at any time.

When a Pro Subscription is canceled, it remains current in `canceled` state until the period ends. On Stripe confirmation that the subscription has ended, the Pro Subscription is marked `expired`, and a new Free Subscription is created.

When a Pro Subscription downgrades to Free, the Pro Subscription row is marked `expired` and a new Free Subscription row is created with Free-tier subscription credits.

---

### Credit Wallet

A Credit Wallet holds all credits for a User.

Credits are an abstract, fungible unit. Consumer applications define what one credit means in their domain. The Billing Service only tracks balances and enforces non-negative balances.

The Credit Wallet has a status:

- **active**: credits can be consumed.
- **frozen**: credits cannot be consumed.

The Credit Wallet contains two separate ledgers:

- **Subscription Credits**
- **Add-on Credits**

---

### Subscription Credits

Subscription Credits are allocated to a User based on their active Subscription plan.

- Free plan: 50 credits per month.
- Pro plan: 200 credits per month.

For monthly subscriptions, credits are allocated when Stripe emits the `invoice.paid` event.

For annual subscriptions, payment is made once upfront, and credits are allocated monthly by an internal scheduled cron job.

The cron queries active annual subscriptions where `nextCreditAt < now`, allocates the plan's monthly credits, records a Credit Transaction, advances `nextCreditAt` by one month, and is idempotent to avoid double-allocation.

If the cron misses one or more months, it catches up by allocating one month at a time for each missed period as separate Credit Transactions.

The cron stops allocating credits once it reaches the Subscription's paid-through boundary; it never allocates credits beyond the paid period.

The paid-through boundary is owned and persisted by the Billing Service, recorded from `invoice.period_end` on each processed `invoice.paid`. It is deliberately **not** read from a Stripe Subscription field at allocation time: Stripe removed `current_period_end` from the Subscription object in API version `2025-03-31.basil`, where it now lives on subscription items. Owning the boundary locally also keeps the cron independent of Stripe availability.

Credits are allocated on `invoice.paid` only for the billing reasons listed under Credit Allocation Triggers in §6.

Subscription Credits reset according to the Subscription plan and billing cycle.

When a Subscription expires, its associated Subscription Credits are forfeited.

Subscription Credits are drawn first when credits are consumed.

---

### Add-on Credits

Add-on Credits are purchased separately as fixed packages through Stripe one-time payments.

- Sold in fixed packages.
- Granted only after Stripe confirms payment success.
- Never expire.
- Never reset.
- Drawn after Subscription Credits are exhausted.

---

### Credit Transaction

A Credit Transaction records a change to a User's credit balance.

Types:

- **allocation**: credits granted from a subscription or add-on purchase.
- **consumption**: credits used by a consumer application.
- **adjustment**: admin-authorized balance change.
- **reset**: subscription credits reset for a new period.

Each transaction is tied to a specific ledger (subscription or add-on).

Admin adjustments may only target Add-on Credits.

---

### Payment Method

A Payment Method represents a stored payment instrument for a User.

Sensitive payment data is handled by Stripe. The Billing Service only stores references and billing-related metadata.

---

### Payment Transaction

A Payment Transaction records a money event.

- Includes subscription payments and add-on credit purchases.
- Records actual money movement only.
- Add-on credit purchases are not refundable.
- Status is synchronized from Stripe.

Stripe does **not** issue refunds during subscription plan changes. A downgrade or cycle change produces a **proration credit** — a negative invoice line item and a credit on the Stripe Customer balance, tracked by Stripe as a `CustomerBalanceTransaction`. No `Refund` object is created unless the Billing Service explicitly requests one, and refund workflow is out of scope (§11).

Proration credits are therefore not Payment Transactions and are never recorded as negative-amount payments. They reduce the amount due on a subsequent invoice, and become visible to the Billing Service through the amount charged on that invoice.

---

### Subscription Event

A Subscription Event records every change to a User's Subscription.

Events include: created, renewed, canceled, expired, downgraded, upgraded, past-due.

Each event captures timestamp, reason, and associated Stripe event reference.

Subscription Events are used for auditability and reconciliation with Stripe event history.

---

### Billing History

Billing History is a derived, read-only view of billing-related activities for a User.

It is aggregated from Payment Transactions, Credit Transactions, and Subscription Events. It does not duplicate events from the source ledgers.

---

## 4. Subscription Management

The system should support subscription lifecycle management.

Capabilities include:

- Creating subscriptions, including Free subscriptions.
- Managing subscription plans.
- Supporting billing cycles.
- Tracking subscription status.
- Handling subscription renewal.
- Handling subscription cancellation.
- Recording subscription events.
- Downgrading from Pro to Free by creating a new Free subscription after the Pro subscription expires.

Supported subscription plans:

- Free.
- Pro.

Supported billing cycles:

- Monthly.
- Annual.

### Plan Catalog Management

Plans and add-on packages are managed by admins through the Billing Service, which creates and updates the corresponding objects in Stripe.

Two distinct things are configured, and neither system owns both:

- **Price** is owned by Stripe, because Stripe performs the charge.
- **Credit entitlement** is owned by the Billing Service. Stripe has no concept of credits.

A local `Plan` record is therefore required regardless of where pricing lives. It holds the credit entitlement and references the Stripe Price.

**Internal identity is the plan `code`** (for example `pro_monthly`), never the Stripe Price ID. Price IDs differ between test and live mode, so they are environment-specific mappings rather than identifiers.

**Creating a plan** writes to Stripe first and the local database second, because network calls are not permitted inside a database transaction. A failure between the two leaves an orphaned Stripe Price; a reconciliation job detects Stripe Prices with no corresponding Plan.

**Every creation call carries a Stripe idempotency key** derived from the plan code, so a retried or double-submitted admin request cannot produce duplicate Products or Prices.

**Prices are immutable in Stripe.** Changing a plan's price creates a new Stripe Price and archives the previous one. The local `Plan` record is repointed to the new Price ID.

**Existing subscribers are migrated to the new price**, taking effect at their next renewal, with no proration and no mid-period charge. The migration is not a stored job. Each Subscription records the Stripe Price it is actually on, so the work is derived from state:

```
subscriptions WHERE status = 'ACTIVE'
  AND stripePriceId <> (its plan's current stripePriceId)
```

The reconciler may be run any number of times: it is idempotent by construction, resumable by construction, and self-healing if a Stripe call fails partway through a batch.

Because the price change is applied with no proration, Stripe generates no immediate invoice, so no `invoice.paid` with `billing_reason=subscription_update` is emitted and no credits are granted. A price change must never trigger credit allocation.

**Changing a plan's credit entitlement** takes effect from the next allocation. Credits already granted are never retroactively adjusted.

**Plans and packages are archived, never deleted**, in both Stripe and the local catalog. Stripe does not permit deleting a Product that has Prices.

**The catalog is enumerated from local records, never by listing Stripe Products.** Unrelated Products in the Stripe account are therefore invisible to the service.

**Add-on packages** follow the same rules, minus subscriber migration: purchases are one-time, so a price change affects only future purchases.

---

## 5. Payment Management

The system should integrate with Stripe for payment processing.

The system should support:

- Creating Stripe Customer.
- Managing payment methods.
- Creating Payment Intents.
- Processing subscription payments.
- Processing add-on credit purchase payments.
- Tracking payment status.
- Receiving Stripe webhook events.
- Recording payment history.

Stripe is responsible for payment execution and payment confirmation.

The Billing Service is responsible for synchronizing and maintaining billing information.

Webhook events should be processed idempotently by Stripe event ID.

All incoming Stripe webhook events are persisted in a `WebhookEvent` table to maintain idempotency, audit history, and support internal retries.

Each `WebhookEvent` record tracks:

- Stripe event ID.
- Event type.
- Raw payload.
- Processing status: `received`, `processing`, `completed`, `failed`.
- Retry count.
- Failure reason.

The endpoint returns a 2xx response after the event is persisted; event processing is performed asynchronously.

Failed events are placed on a retry queue and reprocessed after a fixed backoff time. After exceeding the maximum retry count, events are moved to a dead-letter queue for manual review.

Core webhook events include:

- `customer.created` / `customer.updated`
- `payment_method.attached` / `payment_method.detached`
- `invoice.paid` / `invoice.payment_failed`
- `customer.subscription.created` / `updated` / `deleted`

Stripe webhook events are processed atomically at the Subscription aggregate level. The raw webhook event is persisted first; subscription state changes are applied within a single transaction.

### Event ordering

**Stripe does not guarantee that events arrive in the order they occurred.** Event processing must therefore never assume any ordering between events, and must not infer sequence from arrival.

Observed consequences this system must tolerate:

- `invoice.paid` may arrive before the `customer.subscription.created` or `customer.subscription.updated` describing the subscription it pays for — so the subscription row may be absent, or still `past-due`, at the moment credits would be allocated.
- `customer.subscription.deleted` may arrive before a final `invoice.paid` for the same subscription.
- Any event may be delivered more than once, and duplicates may be interleaved with newer events.

Processing rules:

1. **Re-fetch, do not trust the payload's implied sequence.** When an event is processed, the affected Stripe object is re-fetched from the Stripe API and the current state is applied. The webhook payload is treated as a notification that something changed, not as the authoritative description of what it changed to. This is Stripe's documented mitigation for out-of-order delivery.
2. **Apply a monotonic guard.** State derived from a subscription period is only advanced, never moved backwards, so a late-arriving stale event cannot regress a subscription. The subscription item's period end serves as the version marker.
3. **Defer rather than fail** when an event cannot yet be applied because its subject does not exist locally. The event is left in the retry queue described above and reprocessed after backoff. No separate mechanism is required — the existing retry machinery covers it — but such deferrals must be distinguishable from genuine processing failures so they do not consume the retry budget in the same way.
4. **Idempotency is enforced at two layers**, because they protect against different things. Ingestion is idempotent by Stripe event ID, which stops the identical event being processed twice. Effects that grant value are additionally idempotent on their own natural key, which stops two *distinct* events causing the same grant twice; see Credit Allocation Triggers in §6.

Because processing is order-independent and re-fetches current state, replaying the entire event history must converge on the same result as processing it in order.

---

## 6. Credit Management

The system should manage user credits.

The system should support:

- Allocating subscription credits based on plan and billing cycle.
- Adding purchased add-on credits.
- Consuming credits atomically.
- Tracking credit transactions.
- Resetting subscription credits based on subscription rules.
- Freezing and unfreezing the Credit Wallet based on Subscription status.

### Credit Allocation Triggers

`invoice.paid` is not by itself sufficient to determine whether credits should be granted, or how many. Stripe emits it for several distinct situations, distinguished by the invoice's `billing_reason`:

| `billing_reason` | Meaning | Allocation |
| --- | --- | --- |
| `subscription_create` | First invoice for a new subscription | Allocate the plan's monthly credits. |
| `subscription_cycle` | Scheduled renewal at the period boundary | Allocate the plan's monthly credits. |
| `subscription_update` | Mid-cycle plan change with proration | Allocate the new plan's monthly credits. **Intentional business rule** — see below. |
| `manual`, `subscription_threshold`, other | Not a subscription period event | No allocation. |

**Mid-cycle plan changes grant a full monthly allocation of the new plan.** A user who upgrades mid-period receives the new plan's credits immediately, in addition to what they already hold for the current period. This is a deliberate product decision, not an accounting error: the upgrade is treated as the start of entitlement to the new plan rather than as a prorated adjustment. Proration of the *money* is handled by Stripe independently; credits are not prorated.

**Allocation is idempotent on the subscription and the month, not on the event or the invoice.** A single month's entitlement can be reached from three independent paths: the `invoice.paid` webhook, the monthly cron for annual subscriptions, and the initial grant at registration. Keying on the invoice would not stop these overlapping, because the cron and the registration grant have no invoice at all.

Every allocation therefore carries an **idempotency key** identifying the subscription and the month being credited, enforced by a uniqueness constraint on the Credit Transaction rather than by application logic alone, so that concurrent processing cannot double-allocate.

The key is an opaque string supplied by the caller. The credit ledger does not interpret it and has no knowledge of subscriptions — it only enforces that no two transactions share a key. This keeps the credit module free of any dependency on billing.

The same mechanism serves consumption, where the calling application supplies its own key. Because credits are deducted before the caller's work runs, a retried request without a key would charge twice for one operation.

Zero-amount invoices are auto-marked paid by Stripe and emit `invoice.paid` with no money moved. Free subscriptions do exist in Stripe, so Free credits arrive on this path; the allocation key is what stops them being granted twice when the same month was already credited at registration. A Payment Transaction is not recorded for a zero-amount invoice.

Credit consumption rules:

- Consumption is atomic: either the full requested amount is deducted or the operation fails.
- Decline reasons: `INSUFFICIENT_CREDITS`, `BILLING_FROZEN`.
- Subscription Credits are drawn first, then Add-on Credits.
- **Credits are deducted before the calling application performs its work**, not after. Deducting afterwards would let concurrent requests consume resources the user cannot pay for: ten simultaneous requests against a balance of five would all complete before any balance check took effect.
- The caller supplies an **idempotency key** with every consumption. A retried request after a timeout must charge once, not twice.
- If the caller's work fails after credits were deducted, the caller issues a **reversal**, which restores the credits to the ledger they were drawn from and is recorded as a Credit Transaction of type `reversal` linked to the original consumption. A consumption can be reversed at most once.
- Reversal is distinct from `adjustment`, which remains admin-authorised and limited to Add-on Credits. Without it there would be no legitimate way to return Subscription Credits after a failed operation.

A decline is an ordinary outcome, not a system error. Because declines are reported with a success status code (see the API error model), the service **records a metric for every decline with its reason** — otherwise a user being continuously refused would be indistinguishable from a healthy system.

When a Subscription becomes past-due, the Credit Wallet is frozen. Both Subscription Credits and Add-on Credits cannot be consumed while frozen.

When a past-due Subscription is resolved, the Credit Wallet becomes active again and new Subscription Credits are allocated for the next period. Add-on Credits retain their existing balance.

---

## 7. Add-on Credit Purchase

The system should support additional credit purchases.

Capabilities include:

- Purchasing additional credits in fixed packages.
- Processing add-on payments through Stripe.
- Granting credits only after successful payment confirmation.
- Recording add-on transactions.

---

## 8. Transaction History

The system must maintain complete billing and credit history.

History sources include:

- Subscription events.
- Payment transactions.
- Credit allocations.
- Credit consumption.
- Add-on purchases.

Billing History is a derived view. Source ledgers are:

- Payment Transactions.
- Credit Transactions.
- Subscription Events.

---

## 9. Authentication & Authorization

### Authentication

The system requires authentication for protected operations.

**Scope note.** §11 originally placed the user authentication system out of scope, on the assumption that an upstream Authentication Service would provide it. That is deliberately overridden: this repository contains a minimal authentication module so the Billing Service is self-contained for development and demonstration. It provides registration, login, bcrypt password hashing, JWT access tokens, and USER/ADMIN role-based authorization. It is expected to be replaced by an upstream Authentication Service, and is built to be deleted.

Authentication methods:

- User-facing endpoints require a user token.
- Admin endpoints require an admin token.
- Service-to-service calls use an internal API key for system-level operations, such as triggering credit allocation.

**Tokens** are signed with a symmetric secret (HS256) and carry only subject, role, and expiry. Issuer and audience claims are deliberately omitted: with a single service they would validate nothing. Access tokens are short-lived and paired with a refresh token, whose hash is stored against the credential record so that logout and revocation are possible. That hash uses SHA-256, not bcrypt: a refresh token is a high-entropy machine-generated value with no dictionary to attack, so bcrypt's deliberate cost would buy nothing and would be paid on every refresh. Passwords, which are human-chosen and therefore guessable, are hashed with bcrypt. Asymmetric keys are not used; when an upstream issuer exists it will bring its own key distribution, and the verifier change is small.

**The internal API key authenticates a service, never a user.** It yields a service principal carrying no user identity. Endpoints protected by it must not accept "act on behalf of user X" semantics — they operate on their own scope, such as all subscriptions currently due for allocation. Were the internal key able to assume a user identity, a single leaked environment variable would grant access to every account.

**Replaceability.** Billing and credit code depends only on a verified principal — a user identifier and a role — supplied by the authentication guard. No module outside the authentication module reads its credential storage. Replacing the module with an upstream service means writing a new guard that produces the same principal; nothing else changes.

### Scheduled operations

Credit allocation for annual subscriptions is a single idempotent service operation, reachable from two triggers: an in-process scheduler, and an endpoint protected by the internal API key. Both invoke the same routine.

Running both simultaneously is harmless. Allocation is idempotent on the allocation key described in §6, so a duplicate run allocates nothing.

This allows the service to run locally with no external scheduling infrastructure, while allowing an external scheduler to drive it later without changing the logic.

---

### Authorization

The system supports role-based access control.

Supported roles:

#### User

User-facing endpoints require a user token from the authentication system.

Users can:

- View their subscription.
- Manage payment methods.
- View billing history.
- Consume credits when their Credit Wallet is active.

#### Admin

Admin endpoints require an admin token from the authentication system.

Admins can:

- Manage subscription,addon plans.
- View user billing information.
- Adjust user add-on credits.
- Access administrative billing operations.

---

## 10. Non-functional Requirements

### Reliability

The system should:

- Maintain reliable payment synchronization.
- Handle duplicate billing events safely.
- Process webhook events idempotently.

### Auditability

The system should:

- Maintain traceable billing activities.
- Maintain credit transaction records.
- Maintain subscription event records for reconciliation with Stripe.

### Security

The system should:

- Securely handle payment-related information.
- Protect sensitive operations with authentication and authorization.
- Never store sensitive payment data locally.

### Maintainability

The system should:

- Keep billing logic isolated.
- Support future expansion.

---

## 11. Out of Scope

The following features are not included initially:

- B2B/team billing.
- Multiple users sharing one subscription.
- Multiple payment providers.
- Refund workflow.
- Tax calculation.
- Trial system.
- AI business logic.
- A production-grade authentication system. See the scope note in §9: a minimal authentication module *is* included, deliberately, so the service is self-contained for development and demonstration. What remains out of scope is everything a real Authentication Service would add — federated or social login, multi-factor authentication, password reset flows, session management, and account recovery.
