ALTER TABLE "users" RENAME TO "User";
ALTER TABLE "auth_credentials" RENAME TO "AuthCredential";
ALTER TABLE "billing_customers" RENAME TO "BillingCustomer";
ALTER TABLE "plans" RENAME TO "Plan";
ALTER TABLE "addon_packages" RENAME TO "AddonPackage";
ALTER TABLE "subscriptions" RENAME TO "Subscription";
ALTER TABLE "subscription_events" RENAME TO "SubscriptionEvent";
ALTER TABLE "credit_wallets" RENAME TO "CreditWallet";
ALTER TABLE "credit_transactions" RENAME TO "CreditTransaction";
ALTER TABLE "payment_methods" RENAME TO "PaymentMethod";
ALTER TABLE "payment_transactions" RENAME TO "PaymentTransaction";
ALTER TABLE "webhook_events" RENAME TO "WebhookEvent";

ALTER INDEX "subscriptions_one_current_per_user" RENAME TO "Subscription_one_current_per_user";
ALTER INDEX "subscriptions_pending_sync" RENAME TO "Subscription_pending_sync";
ALTER INDEX "billing_customers_pending_sync" RENAME TO "BillingCustomer_pending_sync";

ALTER TABLE "CreditWallet" RENAME CONSTRAINT "credit_wallets_subscription_credits_non_negative" TO "CreditWallet_subscriptionCredits_non_negative";
ALTER TABLE "CreditWallet" RENAME CONSTRAINT "credit_wallets_addon_credits_non_negative" TO "CreditWallet_addonCredits_non_negative";
ALTER TABLE "Plan" RENAME CONSTRAINT "plans_amounts_non_negative" TO "Plan_amounts_non_negative";
ALTER TABLE "AddonPackage" RENAME CONSTRAINT "addon_packages_amounts_non_negative" TO "AddonPackage_amounts_non_negative";
