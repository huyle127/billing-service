-- Constraints that Prisma's schema language cannot express.
-- Applied as their own migration. Each one enforces an invariant that application code alone
-- cannot guarantee under concurrent access.
--
-- Column identifiers are quoted camelCase because the schema maps table names but not column
-- names. Unquoted snake_case will not resolve.

-- 1. Credit balances can never go negative.
--    Requirements section 6 states consumption is atomic and never partial. Application
--    logic checks this too, but only the database can hold the line when two consume
--    requests race for the same wallet.
ALTER TABLE credit_wallets
  ADD CONSTRAINT credit_wallets_subscription_credits_non_negative
  CHECK ("subscriptionCredits" >= 0);

ALTER TABLE credit_wallets
  ADD CONSTRAINT credit_wallets_addon_credits_non_negative
  CHECK ("addonCredits" >= 0);

-- 2. A user has exactly one current subscription.
--    "Current" means ACTIVE, CANCELED, or PAST_DUE. PENDING rows (payment authentication
--    in flight) and EXPIRED rows (history) are deliberately excluded, which is what allows
--    a pending Pro subscription to coexist with the active Free one it will replace.
CREATE UNIQUE INDEX subscriptions_one_current_per_user
  ON subscriptions ("userId")
  WHERE status IN ('ACTIVE', 'CANCELED', 'PAST_DUE');

-- 3. Catalog amounts are never negative.
ALTER TABLE plans
  ADD CONSTRAINT plans_amounts_non_negative
  CHECK ("amountCents" >= 0 AND "monthlyCredits" >= 0);

ALTER TABLE addon_packages
  ADD CONSTRAINT addon_packages_amounts_non_negative
  CHECK ("amountCents" >= 0 AND credits > 0);

-- 4. Ledger idempotency.
--    Enforced by the unique on credit_transactions."idempotencyKey" declared in schema.prisma.
--    The key is an opaque string supplied by the caller; the credit module never interprets it.
--
--    It serves two different operations:
--      * Allocation -- billing supplies a key identifying the subscription and the month.
--        Three independent paths can reach the same month's entitlement: the invoice.paid
--        webhook, the monthly cron for annual subscriptions, and the initial grant at
--        registration. Keying on the invoice would not stop them overlapping, because two of
--        those three have no invoice at all.
--      * Consumption -- the calling application supplies its own key, so that a retry after a
--        timeout charges once rather than twice. Credits are deducted before the caller's work
--        runs, so a duplicate charge is money the user never gets back without a reversal.
--
--    Postgres treats NULLs as distinct, so rows carrying no key never collide with each other.
--    That NULL behaviour is load-bearing.
--
--    "reversesId" is unique so a consumption can be reversed at most once.

-- 5. Stripe sync backlog indexes.
--    These are what make state-derived reconciliation cheap. Each index contains ONLY the rows
--    still awaiting a Stripe object, so the reconciler's scan cost is proportional to the
--    outstanding backlog rather than to table size. On a healthy system both indexes are
--    nearly empty. Without them the sweep degrades into a full table scan as the service grows.
CREATE INDEX billing_customers_pending_sync
  ON billing_customers ("syncNextAttemptAt")
  WHERE "stripeCustomerId" IS NULL;

CREATE INDEX subscriptions_pending_sync
  ON subscriptions ("syncNextAttemptAt")
  WHERE "stripeSubscriptionId" IS NULL
    AND status IN ('PENDING', 'ACTIVE', 'CANCELED', 'PAST_DUE');

-- Deliberately NOT added: a unique constraint on subscriptions."stripeSubscriptionId".
-- Expired rows are retained as history and a Stripe subscription id can legitimately appear
-- on more than one row across a plan change. An index is enough for lookup.
