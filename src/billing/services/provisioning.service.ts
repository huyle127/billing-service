import { Injectable, Logger } from '@nestjs/common';
import { BillingCustomer } from '@prisma/client';
import { Clock } from '@/common/clock/clock';
import { AppConfigService } from '@/common/config/app-config.service';
import { NotFoundError } from '@/common/errors/domain.exception';
import { UserService } from '@/user/services/user.service';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { StripeCustomer } from '../stripe/types/stripe.types';
import { BillingCustomerRepository } from '../repositories/billing-customer.repository';
import {
  ClaimedSubscription,
  SubscriptionWithPlan,
  SubscriptionRepository,
} from '../repositories/subscription.repository';

export interface SweepSummary {
  subscriptions: number;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly customers: BillingCustomerRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly users: UserService,
    private readonly stripe: StripeService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
  ) {}

  async provision(userId: string): Promise<void> {
    const customerId = await this.ensureCustomer(userId);

    await this.ensureStripeSubscription(userId, customerId);
  }

  async ensureCustomer(userId: string): Promise<string> {
    const customer = await this.customers.findByUserId(userId);

    if (!customer) throw new NotFoundError('This user has no billing customer', { userId });
    if (customer.stripeCustomerId) return customer.stripeCustomerId;

    try {
      const stripeCustomer =
        (await this.stripe.findCustomerByUserId(userId)) ?? (await this.createCustomer(userId));

      await this.customers.attachStripeCustomer(customer.id, stripeCustomer.id);

      return stripeCustomer.id;
    } catch (error) {
      await this.recordCustomerFailure(customer, error);

      throw error;
    }
  }

  async sweep(): Promise<SweepSummary> {
    const claimedAt = this.clock.now();
    const claimed = await this.subscriptions.claimPending(
      claimedAt,
      this.config.provisioningBatchSize,
      (syncAttempts) => this.nextAttemptAt(syncAttempts),
    );

    for (const row of claimed) {
      this.escalateIfStale(row, claimedAt);

      await this.provision(row.userId).catch((error: unknown) => {
        this.logger.warn(`Provisioning subscription ${row.id} failed: ${reasonOf(error)}`);
      });
    }

    return { subscriptions: claimed.length };
  }

  private async ensureStripeSubscription(userId: string, customerId: string): Promise<void> {
    const subscription = await this.subscriptions.findPendingByUserId(userId);

    if (!subscription) return;

    try {
      const stripeSubscription =
        (await this.stripe.findSubscriptionByLocalId(subscription.id)) ??
        (await this.stripe.createSubscription({
          subscriptionId: subscription.id,
          userId,
          customerId,
          priceId: subscription.plan.stripePriceId,
        }));

      await this.subscriptions.attachStripeSubscription(subscription.id, {
        stripeSubscriptionId: stripeSubscription.id,
        stripePriceId: stripeSubscription.priceId,
        stripeStatus: stripeSubscription.status,
      });
    } catch (error) {
      await this.recordSubscriptionFailure(subscription, error);

      throw error;
    }
  }

  private async createCustomer(userId: string): Promise<StripeCustomer> {
    const user = await this.users.findById(userId);

    if (!user) throw new NotFoundError('This user does not exist', { userId });

    return this.stripe.createCustomer({ userId, email: user.email });
  }

  private recordCustomerFailure(customer: BillingCustomer, error: unknown): Promise<void> {
    return this.customers.recordFailure(
      customer.id,
      reasonOf(error),
      this.nextAttemptAt(customer.syncAttempts),
    );
  }

  private recordSubscriptionFailure(
    subscription: SubscriptionWithPlan,
    error: unknown,
  ): Promise<void> {
    return this.subscriptions.recordFailure(
      subscription.id,
      reasonOf(error),
      this.nextAttemptAt(subscription.syncAttempts),
    );
  }

  private nextAttemptAt(syncAttempts: number): Date {
    const backoff = Math.min(
      this.config.provisioningRetryBackoffMs * 2 ** syncAttempts,
      this.config.provisioningStaleAfterMs,
    );

    return new Date(this.clock.now().getTime() + backoff);
  }

  private escalateIfStale(subscription: ClaimedSubscription, at: Date): void {
    const age = at.getTime() - subscription.createdAt.getTime();

    if (age < this.config.provisioningStaleAfterMs) return;

    this.logger.error(
      `Subscription ${subscription.id} has had no Stripe object for ${age}ms after ` +
        `${subscription.syncAttempts} attempts: ${subscription.syncError ?? 'no failure recorded'}`,
    );
  }
}
