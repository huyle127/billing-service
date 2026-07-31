import { Injectable } from '@nestjs/common';
import type { CreditBalance } from '../credits/credits.service';
import { CreditsService } from '../credits/credits.service';
import type {
  BillingInterval,
  SubscriptionStatus,
} from '../generated/prisma/enums';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { toEntitlementState } from './subscription-status';

export interface BillingStateSubscription {
  id: string;
  planKey: string;
  planName: string;
  isPaidPlan: boolean;
  /** The provider's status, projected. Never a local invention. */
  status: SubscriptionStatus;
  billingInterval: BillingInterval;
  billingIntervalCount: number;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextCreditResetAt: Date | null;
  /**
   * Whether the subscription will renew at the end of the current period. A
   * pending period-end cancellation shows up here and in `currentPeriodEnd` — not
   * as a status, and not as the user already being on Free.
   */
  willRenew: boolean;
  cancelAtPeriodEnd: boolean;
  /** Stripe's dunning state, mirrored for observability. Drives nothing local. */
  paymentAttemptCount: number;
  nextPaymentAttemptAt: Date | null;
  providerSubscriptionId: string;
}

export interface BillingState {
  productId: string;
  /** Null only in the transient window where a user has no live subscription. */
  subscription: BillingStateSubscription | null;
  credits: CreditBalance;
  /** True when no credit can be spent right now, whatever the balance is. */
  consumptionFrozen: boolean;
}

/**
 * The current billing state for one user and Product.
 *
 * Two things this read is careful about, both of which a simpler shape would get
 * wrong:
 *
 * - **Frozen credit is reported, not hidden.** A past-due or Free user still owns
 *   their balance; reporting zero would misrepresent preserved credit as spent.
 *   Spendable and frozen are separate numbers, with the reason alongside.
 * - **A pending cancellation is not a plan change.** The user is on Pro with an
 *   active status until the provider says otherwise; what changes is that the
 *   subscription will not renew.
 */
@Injectable()
export class BillingStateService {
  constructor(
    private readonly subscriptions: SubscriptionLookupService,
    private readonly credits: CreditsService,
  ) {}

  async getBillingState(
    userId: string,
    productId: string,
  ): Promise<BillingState> {
    const live = await this.subscriptions.findLive(userId, productId);

    const entitlement = toEntitlementState(
      live && { status: live.status, isPaidPlan: live.plan.isPaid },
    );
    const credits = await this.credits.getBalance(
      userId,
      productId,
      entitlement,
    );

    return {
      productId,
      subscription: live && {
        id: live.id,
        planKey: live.plan.key,
        planName: live.plan.name,
        isPaidPlan: live.plan.isPaid,
        status: live.status,
        billingInterval: live.pricingOption.billingInterval,
        billingIntervalCount: live.pricingOption.billingIntervalCount,
        currentPeriodStart: live.currentPeriodStart,
        currentPeriodEnd: live.currentPeriodEnd,
        nextCreditResetAt: live.nextCreditResetAt,
        willRenew: !live.cancelAtPeriodEnd,
        cancelAtPeriodEnd: live.cancelAtPeriodEnd,
        paymentAttemptCount: live.paymentAttemptCount,
        nextPaymentAttemptAt: live.nextPaymentAttemptAt,
        providerSubscriptionId: live.providerSubscriptionId,
      },
      credits,
      consumptionFrozen: credits.freezeReason !== null,
    };
  }
}
