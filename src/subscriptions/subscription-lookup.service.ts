import { HttpStatus, Injectable } from '@nestjs/common';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import type { EntitlementState } from '../credits/spendability';
import { SubscriptionRepository } from './subscription.repository';
import type { SubscriptionWithCatalog } from './subscription.repository';
import { toEntitlementState } from './subscription-status';

/**
 * A Subscription with the catalog rows every caller of it needs: the plan to
 * know what it entitles, the pricing option to know what it bills. One type,
 * because a second one differing only by which relation it carries is how two
 * services end up disagreeing about what a subscription *is*.
 *
 * Defined alongside the query that produces it, and re-exported here so the
 * callers that already import it from this service keep working.
 */
export type { SubscriptionWithCatalog } from './subscription.repository';

/**
 * "Which Subscription is live for this user and Product, and what does holding
 * it entitle them to?"
 *
 * One definition of that query, because several callers ask it for different
 * reasons — add-on eligibility, the billing-state read, credit spendability —
 * and they must not be able to disagree about which row is live or whether its
 * plan is paid.
 */
@Injectable()
export class SubscriptionLookupService {
  constructor(private readonly subscriptions: SubscriptionRepository) {}

  findLive(
    userId: string,
    productId: string,
  ): Promise<SubscriptionWithCatalog | null> {
    return this.subscriptions.findLive(userId, productId);
  }

  /**
   * One of this user's subscriptions, by id.
   *
   * Every subscription command names a subscription in its URL, and the id
   * alone says nothing about whose it is. Scoping the lookup by `userId` is
   * what stops a caller acting on someone else's — and the answer for a
   * subscription that belongs to another user is deliberately the same as for
   * one that does not exist.
   */
  async requireOwned(
    userId: string,
    subscriptionId: string,
  ): Promise<SubscriptionWithCatalog> {
    const subscription = await this.subscriptions.findOwned(
      userId,
      subscriptionId,
    );

    if (!subscription) {
      throw new BillingException(
        ErrorCode.NotFound,
        'No such subscription.',
        HttpStatus.NOT_FOUND,
      );
    }
    return subscription;
  }

  /**
   * The live Subscription, refused unless it is on a paid plan.
   *
   * `purpose` names the operation in the message, because "you need a paid
   * subscription" is only actionable if the user knows what for.
   */
  async requireLivePaid(
    userId: string,
    productId: string,
    purpose: string,
  ): Promise<SubscriptionWithCatalog> {
    const live = await this.findLive(userId, productId);

    if (!live?.plan.isPaid) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        live
          ? `${purpose} requires a live paid subscription for this product; ` +
              `this user is on the ${live.plan.key} plan.`
          : `${purpose} requires a live paid subscription for this product; ` +
              `this user has none.`,
        HttpStatus.CONFLICT,
        { planKey: live?.plan.key ?? null },
      );
    }

    return live;
  }

  /**
   * The entitlement state the credit rules take as input. Derived from the live
   * Subscription's plan and its provider-reported status — never from a stored
   * entitlement flag.
   */
  async entitlementFor(
    userId: string,
    productId: string,
  ): Promise<EntitlementState> {
    const live = await this.findLive(userId, productId);

    return toEntitlementState(
      live && { status: live.status, isPaidPlan: live.plan.isPaid },
    );
  }
}
