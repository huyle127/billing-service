import { Injectable } from '@nestjs/common';
import type {
  BillingInterval,
  SubscriptionStatus,
} from '../generated/prisma/enums';
import { SubscriptionRepository } from './subscription.repository';
import { isLive } from './subscription-status';

export interface SubscriptionHistoryEntry {
  id: string;
  planKey: string;
  planName: string;
  isPaidPlan: boolean;
  billingInterval: BillingInterval;
  billingIntervalCount: number;
  unitAmount: number;
  currency: string;
  status: SubscriptionStatus;
  /** A classification of the provider's status, not a stored value. */
  isLive: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextCreditResetAt: Date | null;
  providerSubscriptionId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Subscription history.
 *
 * There is no separate history table, and there is no event log: because plan
 * changes create new rows rather than mutating existing ones, the sequence of
 * rows *is* the history. Terminal rows are therefore never deleted and are
 * returned here alongside the live one.
 *
 * A cycle change is the exception that proves the rule — it happens on one row,
 * so it shows up as that row's current pricing rather than as a new entry.
 */
@Injectable()
export class SubscriptionHistoryService {
  constructor(private readonly subscriptions: SubscriptionRepository) {}

  async listSubscriptionHistory(
    userId: string,
    productId: string,
  ): Promise<SubscriptionHistoryEntry[]> {
    const rows = await this.subscriptions.listForProduct(userId, productId);

    return rows.map((row) => ({
      id: row.id,
      planKey: row.plan.key,
      planName: row.plan.name,
      isPaidPlan: row.plan.isPaid,
      billingInterval: row.pricingOption.billingInterval,
      billingIntervalCount: row.pricingOption.billingIntervalCount,
      unitAmount: row.pricingOption.unitAmount,
      currency: row.pricingOption.currency,
      status: row.status,
      isLive: isLive(row.status),
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      nextCreditResetAt: row.nextCreditResetAt,
      providerSubscriptionId: row.providerSubscriptionId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }
}
