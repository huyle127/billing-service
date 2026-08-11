import { BillingCycle, SubscriptionStatus } from '@prisma/client';
import { LEDGER_TRANSACTION } from '../credit/credit.constants';

export const FREE_PLAN = {
  code: 'free',
  cycle: BillingCycle.MONTHLY,
} as const;

export const REGISTRATION_TRANSACTION = LEDGER_TRANSACTION;

export const LIFECYCLE_TRANSACTION = LEDGER_TRANSACTION;

export const WEBHOOK_TRANSACTION = LEDGER_TRANSACTION;

export const PENDING_SYNC_STATUSES = [
  SubscriptionStatus.PENDING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.CANCELED,
  SubscriptionStatus.PAST_DUE,
] as const;

export const CURRENT_STATUSES = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.CANCELED,
  SubscriptionStatus.PAST_DUE,
] as const;

export const CREDITABLE_STATUSES = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.CANCELED,
] as const;

export const DEFAULT_CURRENCY = 'usd';

export const PROVISIONING_SWEEP = 'provisioning.sweep';

export const ANNUAL_ALLOCATION_SWEEP = 'allocation.annual';

export const CATALOG_MIGRATION_SWEEP = 'catalog.migration';

export const ALLOCATION_KEYS = {
  month: (subscriptionId: string, at: Date): string =>
    `sub:${subscriptionId}:${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`,
} as const;

export const ALLOCATION_REASONS = {
  registration: 'registration',
  invoicePaid: 'invoice_paid',
  annualCron: 'annual_cron',
} as const;

export const TRANSITION_REASONS = {
  activated: 'activated',
  renewed: 'renewed',
  resumed: 'resumed',
  superseded: 'superseded',
  canceled: 'canceled',
  pastDue: 'past_due',
  expired: 'expired',
} as const;
