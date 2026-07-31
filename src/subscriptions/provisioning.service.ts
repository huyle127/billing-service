import { Inject, Injectable, Logger } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { isUniqueViolation } from '../common/prisma-errors';
import { CustomersService } from '../customers/customers.service';
import { BillingInterval } from '../generated/prisma/enums';
import type { SubscriptionModel } from '../generated/prisma/models';
import { Prisma } from '../generated/prisma/client';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type {
  BillingProvider,
  ProviderSubscription,
} from '../provider/billing-provider';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { SubscriptionRepository } from './subscription.repository';

/**
 * Everything needed to write the local Free row, with the provider side already
 * done. Produced outside a transaction and consumed inside one, which is how the
 * "no Stripe call inside a database transaction" rule survives a transition that
 * must create the provider subscription and commit the row atomically.
 */
export interface PreparedFreeSubscription {
  userId: string;
  productId: string;
  planId: string;
  pricingOptionId: string;
  providerSubscription: ProviderSubscription;
}

/**
 * Free provisioning.
 *
 * Reachable from exactly three callers: registration, the provider-driven
 * Pro → Free transition, and the reconciliation repair job. It is *not*
 * reachable from a cancellation request that has not yet taken effect at the
 * provider — a user who asks to cancel at period end keeps Pro until the
 * provider says otherwise, so provisioning Free at request time would cut
 * their entitlement short by up to a billing period.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly customers: CustomersService,
    private readonly subscriptions: SubscriptionLookupService,
    private readonly subscriptionRows: SubscriptionRepository,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /**
   * Gives a user exactly one live Free Subscription for a product, and is safe
   * to call when they already have a live one.
   *
   * The provider subscription is created *before* the local row, so a local row
   * never exists without a `providerSubscriptionId`. The cost is that a crash
   * in between leaves an orphan at the provider — the deliberate trade in
   * design R3, and what orphan cleanup exists to resolve.
   */
  async provisionFreeSubscription(
    userId: string,
    productId: string,
  ): Promise<SubscriptionModel> {
    const existing = await this.subscriptions.findLive(userId, productId);
    if (existing) {
      return existing;
    }

    const prepared = await this.prepareFreeSubscription(userId, productId);

    try {
      return await this.insertFreeSubscriptionRow(this.prisma, prepared);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Another caller provisioned concurrently and won the live index. That is
      // success, not an error — but the provider subscription this call created
      // would be an orphan, so it is cancelled rather than left behind.
      return this.yieldTo(prepared, error);
    }
  }

  /**
   * The provider half: resolves the Free SKU and creates the $0 provider
   * subscription. Separate from the local write so a caller that needs the row
   * inside its own transaction — the Pro → Free transition — can still issue the
   * Stripe call before opening it.
   */
  async prepareFreeSubscription(
    userId: string,
    productId: string,
  ): Promise<PreparedFreeSubscription> {
    const freePlan = await this.catalog.resolveSolePlan(productId, false);
    const pricingOption = await this.catalog.resolvePricingOption(
      freePlan.id,
      BillingInterval.MONTH,
    );

    const customerId = await this.customers.getOrCreateStripeCustomer(userId);

    // A $0 price needs no payment method, so this succeeds for a user who has
    // never paid anything.
    const providerSubscription = await this.provider.createSubscription({
      customerId,
      priceId: pricingOption.stripePriceId,
      metadata: { userId, productId, planKey: freePlan.key },
    });

    return {
      userId,
      productId,
      planId: freePlan.id,
      pricingOptionId: pricingOption.id,
      providerSubscription,
    };
  }

  /**
   * The local half, and the only place a Free Subscription row is written. It
   * takes a client rather than using its own, so the row can join a transition's
   * transaction and the one-live-row index can arbitrate between the row leaving
   * the live set and this one entering it.
   *
   * No credit grant is written here: Free's credits arrive with its own
   * `$0 invoice.paid` through the standing allocation routine (design D4b).
   */
  insertFreeSubscriptionRow(
    client: Prisma.TransactionClient,
    prepared: PreparedFreeSubscription,
  ): Promise<SubscriptionModel> {
    const { providerSubscription: atProvider } = prepared;

    return this.subscriptionRows.insert(client, {
      userId: prepared.userId,
      productId: prepared.productId,
      planId: prepared.planId,
      pricingOptionId: prepared.pricingOptionId,
      providerSubscriptionId: atProvider.id,
      status: atProvider.status,
      cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
      currentPeriodStart: atProvider.currentPeriodStart,
      currentPeriodEnd: atProvider.currentPeriodEnd,
      nextCreditResetAt: atProvider.currentPeriodEnd,
    });
  }

  /**
   * Cancels a provider subscription whose local row was never written, so losing
   * a race leaves nothing behind at the provider. Never fails the caller: the
   * race was won by someone, and reconciliation covers what this could not.
   */
  async discardPreparedSubscription(
    prepared: PreparedFreeSubscription,
  ): Promise<void> {
    try {
      await this.provider.cancelSubscriptionNow(
        prepared.providerSubscription.id,
      );
    } catch (error) {
      this.logger.warn(
        `Could not cancel superseded provider subscription ` +
          `${prepared.providerSubscription.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async yieldTo(
    prepared: PreparedFreeSubscription,
    original: unknown,
  ): Promise<SubscriptionModel> {
    await this.discardPreparedSubscription(prepared);

    const winner = await this.subscriptions.findLive(
      prepared.userId,
      prepared.productId,
    );
    if (!winner) {
      throw original;
    }
    return winner;
  }
}
