-- AlterTable
ALTER TABLE "AddonPackage" RENAME CONSTRAINT "addon_packages_pkey" TO "AddonPackage_pkey";

-- AlterTable
ALTER TABLE "AuthCredential" RENAME CONSTRAINT "auth_credentials_pkey" TO "AuthCredential_pkey";

-- AlterTable
ALTER TABLE "BillingCustomer" RENAME CONSTRAINT "billing_customers_pkey" TO "BillingCustomer_pkey";

-- AlterTable
ALTER TABLE "CreditTransaction" RENAME CONSTRAINT "credit_transactions_pkey" TO "CreditTransaction_pkey";

-- AlterTable
ALTER TABLE "CreditWallet" RENAME CONSTRAINT "credit_wallets_pkey" TO "CreditWallet_pkey";

-- AlterTable
ALTER TABLE "PaymentMethod" RENAME CONSTRAINT "payment_methods_pkey" TO "PaymentMethod_pkey";

-- AlterTable
ALTER TABLE "PaymentTransaction" RENAME CONSTRAINT "payment_transactions_pkey" TO "PaymentTransaction_pkey";

-- AlterTable
ALTER TABLE "Plan" RENAME CONSTRAINT "plans_pkey" TO "Plan_pkey";

-- AlterTable
ALTER TABLE "Subscription" RENAME CONSTRAINT "subscriptions_pkey" TO "Subscription_pkey";

-- AlterTable
ALTER TABLE "SubscriptionEvent" RENAME CONSTRAINT "subscription_events_pkey" TO "SubscriptionEvent_pkey";

-- AlterTable
ALTER TABLE "User" RENAME CONSTRAINT "users_pkey" TO "User_pkey";

-- AlterTable
ALTER TABLE "WebhookEvent" RENAME CONSTRAINT "webhook_events_pkey" TO "WebhookEvent_pkey";

-- RenameForeignKey
ALTER TABLE "AuthCredential" RENAME CONSTRAINT "auth_credentials_userId_fkey" TO "AuthCredential_userId_fkey";

-- RenameForeignKey
ALTER TABLE "BillingCustomer" RENAME CONSTRAINT "billing_customers_userId_fkey" TO "BillingCustomer_userId_fkey";

-- RenameForeignKey
ALTER TABLE "CreditTransaction" RENAME CONSTRAINT "credit_transactions_reversesId_fkey" TO "CreditTransaction_reversesId_fkey";

-- RenameForeignKey
ALTER TABLE "CreditTransaction" RENAME CONSTRAINT "credit_transactions_walletId_fkey" TO "CreditTransaction_walletId_fkey";

-- RenameForeignKey
ALTER TABLE "CreditWallet" RENAME CONSTRAINT "credit_wallets_userId_fkey" TO "CreditWallet_userId_fkey";

-- RenameForeignKey
ALTER TABLE "PaymentMethod" RENAME CONSTRAINT "payment_methods_userId_fkey" TO "PaymentMethod_userId_fkey";

-- RenameForeignKey
ALTER TABLE "PaymentTransaction" RENAME CONSTRAINT "payment_transactions_userId_fkey" TO "PaymentTransaction_userId_fkey";

-- RenameForeignKey
ALTER TABLE "Subscription" RENAME CONSTRAINT "subscriptions_planId_fkey" TO "Subscription_planId_fkey";

-- RenameForeignKey
ALTER TABLE "Subscription" RENAME CONSTRAINT "subscriptions_userId_fkey" TO "Subscription_userId_fkey";

-- RenameForeignKey
ALTER TABLE "SubscriptionEvent" RENAME CONSTRAINT "subscription_events_subscriptionId_fkey" TO "SubscriptionEvent_subscriptionId_fkey";

-- RenameIndex
ALTER INDEX "addon_packages_code_key" RENAME TO "AddonPackage_code_key";

-- RenameIndex
ALTER INDEX "addon_packages_stripePriceId_key" RENAME TO "AddonPackage_stripePriceId_key";

-- RenameIndex
ALTER INDEX "auth_credentials_userId_key" RENAME TO "AuthCredential_userId_key";

-- RenameIndex
ALTER INDEX "billing_customers_stripeCustomerId_key" RENAME TO "BillingCustomer_stripeCustomerId_key";

-- RenameIndex
ALTER INDEX "billing_customers_userId_key" RENAME TO "BillingCustomer_userId_key";

-- RenameIndex
ALTER INDEX "credit_transactions_idempotencyKey_ledger_key" RENAME TO "CreditTransaction_idempotencyKey_ledger_key";

-- RenameIndex
ALTER INDEX "credit_transactions_reversesId_key" RENAME TO "CreditTransaction_reversesId_key";

-- RenameIndex
ALTER INDEX "credit_transactions_walletId_createdAt_idx" RENAME TO "CreditTransaction_walletId_createdAt_idx";

-- RenameIndex
ALTER INDEX "credit_wallets_userId_key" RENAME TO "CreditWallet_userId_key";

-- RenameIndex
ALTER INDEX "payment_methods_stripePaymentMethodId_key" RENAME TO "PaymentMethod_stripePaymentMethodId_key";

-- RenameIndex
ALTER INDEX "payment_methods_userId_idx" RENAME TO "PaymentMethod_userId_idx";

-- RenameIndex
ALTER INDEX "payment_transactions_stripeInvoiceId_key" RENAME TO "PaymentTransaction_stripeInvoiceId_key";

-- RenameIndex
ALTER INDEX "payment_transactions_userId_occurredAt_idx" RENAME TO "PaymentTransaction_userId_occurredAt_idx";

-- RenameIndex
ALTER INDEX "plans_code_cycle_key" RENAME TO "Plan_code_cycle_key";

-- RenameIndex
ALTER INDEX "plans_stripePriceId_key" RENAME TO "Plan_stripePriceId_key";

-- RenameIndex
ALTER INDEX "subscriptions_status_nextCreditAt_idx" RENAME TO "Subscription_status_nextCreditAt_idx";

-- RenameIndex
ALTER INDEX "subscriptions_status_planId_stripePriceId_idx" RENAME TO "Subscription_status_planId_stripePriceId_idx";

-- RenameIndex
ALTER INDEX "subscriptions_stripeSubscriptionId_idx" RENAME TO "Subscription_stripeSubscriptionId_idx";

-- RenameIndex
ALTER INDEX "subscriptions_userId_status_idx" RENAME TO "Subscription_userId_status_idx";

-- RenameIndex
ALTER INDEX "subscription_events_subscriptionId_occurredAt_idx" RENAME TO "SubscriptionEvent_subscriptionId_occurredAt_idx";

-- RenameIndex
ALTER INDEX "users_email_key" RENAME TO "User_email_key";

-- RenameIndex
ALTER INDEX "webhook_events_status_nextAttemptAt_idx" RENAME TO "WebhookEvent_status_nextAttemptAt_idx";

-- RenameIndex
ALTER INDEX "webhook_events_stripeEventId_key" RENAME TO "WebhookEvent_stripeEventId_key";
