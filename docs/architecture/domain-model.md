# Domain Model: Billing Service

## Core Entities

### User

A User represents a customer using the platform.

- The Billing Service manages billing information for a User.
- Each User has a corresponding Stripe Customer for payment operations.
- A User owns one Subscription, one Credit Wallet, and one Billing History.

### Subscription

A Subscription represents the user's current billing plan.

- Supported plans: Free, Pro.
  - Free: 50 subscription credits per month.
  - Pro: 200 subscription credits per month.
- Supported billing cycles: Monthly, Annual.
  - Monthly: subscription paid every month; credits allocated on `invoice.paid`.
  - Annual: subscription paid once per year; credits allocated monthly by cron.
- Supported billing cycles: Monthly, Annual.
- A Subscription has a lifecycle: active, canceled, expired, past-due.
  - **active**: the subscription is currently valid and will renew.
  - **canceled**: the user has chosen not to renew; access and credits continue until the current period ends.
  - **expired**: the subscription period has ended and will not renew.
  - **past-due**: a renewal payment has failed; the Credit Wallet is frozen.
- **The lifecycle belongs to the Billing Service.** These states are set by this service, not mirrored from Stripe. Stripe events are inputs that trigger transitions; no business rule branches on a Stripe status value. The trigger for each transition is listed in the requirements document under Subscription.
- The Subscription also stores Stripe's raw status in `stripeStatus`, for reconciliation and audit only.
- Stripe's vocabulary collides with ours without matching it: a subscription Stripe reports as `canceled` has already ended, which is our `expired`. Our state is set independently precisely to avoid that trap.
- A subscription pending payment authentication (3DS/SCA) is recorded but does **not** become the User's current Subscription until payment is confirmed.
- Subscription credits are allocated based on the active Subscription plan.

### Credit Wallet

A Credit Wallet holds all credits for a User.

- Credits are an abstract, fungible unit interpreted by consumer applications.
- The Billing Service only tracks balances and enforces non-negative balances.
- Has a status: **active** or **frozen**.
- When frozen, no credits can be consumed.
- It contains two separate ledgers:
  - **Subscription Credits**
  - **Add-on Credits**

### Subscription Credits

Credits allocated to a User based on their active Subscription plan.

- Allocated based on the User's active Subscription plan.
- Reset according to subscription rules (e.g., monthly or annual reset).
- Forfeited when the associated Subscription expires.
- Drawn first when credits are consumed.

### Add-on Credits

Credits purchased separately as a one-time payment.

- Sold in fixed packages.
- Granted only after Stripe confirms payment success.
- Never expire.
- Never reset.
- Drawn after Subscription Credits are exhausted.

### Credit Transaction

A Credit Transaction records a change to a User's credit balance.

- Types: allocation, consumption, adjustment, reset.
- Adjustment transactions may only target Add-on Credits.
- Always tied to a specific credit ledger (subscription or add-on).

### Payment Method

A stored payment method for a User.

- Sensitive payment data is handled by Stripe.
- The Billing Service only stores references and metadata.

### Payment Transaction

A Payment Transaction records a payment event.

- Includes subscription payments and add-on credit purchases.
- Status is synchronized from Stripe.

### Subscription Event

A Subscription Event records every change to a User's Subscription.

- Events include: created, renewed, canceled, expired, downgraded, upgraded, past-due.
- Captures timestamp, reason, and associated Stripe event reference.
- Used for auditability and reconciliation with Stripe event history.

### Billing History

A derived, read-only view of billing-related activities for a User.

- Aggregated from Payment Transactions, Credit Transactions, and Subscription change events.
- Does not duplicate events from the source ledgers.

## Domain Rules

- A User has exactly one active Subscription at a time.
- Subscription credits are allocated based on the Subscription plan.
  - Free: 50 credits per month.
  - Pro: 200 credits per period (monthly or annually).
- For monthly subscriptions, credits are allocated on Stripe's `invoice.paid` webhook, but only for the billing reasons `subscription_create`, `subscription_cycle`, and `subscription_update`.
- A mid-cycle plan change grants a full monthly allocation of the new plan. This is an intentional business rule: credits are not prorated, only money is.
- Credit allocation is idempotent on invoice ID plus billing period, enforced by a uniqueness constraint. This is a separate concern from webhook ingestion idempotency, which keys on Stripe event ID.
- For annual subscriptions, credits are allocated monthly by a scheduled cron job, while payment is made once upfront.
- Webhook processing must not assume any ordering between Stripe events. Event handlers re-fetch the affected object from Stripe rather than trusting the payload's implied sequence.
- When a Subscription expires, its associated Subscription Credits are forfeited.
- When a Pro Subscription expires or downgrades to Free, the Pro Subscription row is marked expired and a new Free Subscription row is created with Free-tier Subscription Credits.
- Add-on credits never expire and are only consumed after subscription credits are exhausted.
- Credit consumption is atomic: either the full requested amount is deducted or the operation fails with no partial deduction.
- Possible failure reasons: `INSUFFICIENT_CREDITS`, `BILLING_FROZEN`.
- Credit consumption draws from Subscription Credits first, then Add-on Credits.
- A Credit Wallet becomes frozen when the User's Subscription is past-due, and active again when the Subscription is resolved.
- All credit changes must be recorded as Credit Transactions.
- Payment-sensitive data is never stored by the Billing Service.
