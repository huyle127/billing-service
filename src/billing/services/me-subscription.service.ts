import { Injectable } from '@nestjs/common';
import { BillingCycle, Plan, Prisma, SubscriptionStatus } from '@prisma/client';
import { Clock } from '../../common/clock/clock';
import { NotFoundError, ValidationError } from '../../common/errors/domain.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FREE_PLAN, LIFECYCLE_TRANSACTION, TRANSITION_REASONS } from '../billing.constants';
import {
  SubscriptionRepository,
  SubscriptionWithPlan,
} from '../repositories/subscription.repository';
import { PlanRepository } from '../repositories/plan.repository';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { ProvisioningService } from './provisioning.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { LIFECYCLE_EVENTS } from './subscription-transitions';

export interface PlanChoice {
  planCode: string;
  cycle: BillingCycle;
  paymentMethodId?: string;
}

export interface SubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  cycle: BillingCycle;
  planCode: string;
  monthlyCredits: number;
  startedAt: Date;
  paidThroughAt: Date | null;
  canceledAt: Date | null;
  pendingPlanId: string | null;
}

export interface MeSubscriptionView {
  current: SubscriptionSummary | null;
  awaitingPayment: SubscriptionSummary | null;
}

function summarise(subscription: SubscriptionWithPlan): SubscriptionSummary {
  return {
    id: subscription.id,
    status: subscription.status,
    cycle: subscription.cycle,
    planCode: subscription.plan.code,
    monthlyCredits: subscription.plan.monthlyCredits,
    startedAt: subscription.startedAt,
    paidThroughAt: subscription.paidThroughAt,
    canceledAt: subscription.canceledAt,
    pendingPlanId: subscription.pendingPlanId,
  };
}

function isFree(subscription: SubscriptionWithPlan): boolean {
  return subscription.plan.code === FREE_PLAN.code;
}

@Injectable()
export class MeSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly plans: PlanRepository,
    private readonly provisioning: ProvisioningService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly stripe: StripeService,
    private readonly clock: Clock,
  ) {}

  async view(userId: string): Promise<MeSubscriptionView> {
    const [current, awaitingPayment] = await Promise.all([
      this.subscriptions.findCurrentWithPlan(userId),
      this.subscriptions.findAwaitingPayment(userId),
    ]);

    return {
      current: current ? summarise(current) : null,
      awaitingPayment: awaitingPayment ? summarise(awaitingPayment) : null,
    };
  }

  async subscribe(userId: string, choice: PlanChoice): Promise<MeSubscriptionView> {
    const current = await this.requireCurrent(userId);
    const plan = await this.requireActivePlan(choice);

    if (current.status === SubscriptionStatus.CANCELED) {
      return this.resume(userId, current, plan, this.requireStripeId(current));
    }

    if (!isFree(current)) {
      throw new ValidationError('Change an existing paid subscription with PATCH, not POST', {
        planCode: current.plan.code,
      });
    }

    if (plan.code === FREE_PLAN.code) {
      throw new ValidationError('This account is already on the Free plan');
    }

    const customerId = await this.provisioning.ensureCustomer(userId);
    const pending = await this.prisma.$transaction((tx) =>
      this.subscriptions.createPending(tx, {
        userId,
        planId: plan.id,
        cycle: plan.cycle,
        startedAt: this.clock.now(),
      }),
    );

    const remote = await this.stripe.createSubscription({
      subscriptionId: pending.id,
      userId,
      customerId,
      priceId: plan.stripePriceId,
      defaultPaymentMethodId: choice.paymentMethodId,
    });

    await this.subscriptions.attachStripeSubscription(pending.id, {
      stripeSubscriptionId: remote.id,
      stripePriceId: remote.priceId,
      stripeStatus: remote.status,
    });

    return this.view(userId);
  }

  async change(userId: string, choice: PlanChoice): Promise<MeSubscriptionView> {
    const current = await this.requireCurrent(userId);
    const plan = await this.requireActivePlan(choice);

    if (isFree(current)) {
      throw new ValidationError('Subscribe to a paid plan with POST, not PATCH');
    }

    if (plan.id === current.planId) {
      throw new ValidationError('This account is already on that plan', { planCode: plan.code });
    }

    const stripeId = this.requireStripeId(current);

    return plan.amountCents < current.plan.amountCents
      ? this.hold(userId, current, plan, stripeId)
      : this.upgrade(userId, current, plan, stripeId);
  }

  async cancel(userId: string): Promise<MeSubscriptionView> {
    const current = await this.requireCurrent(userId);

    if (isFree(current)) {
      throw new ValidationError('The Free plan cannot be cancelled');
    }

    await this.stripe.cancelSubscription(this.requireStripeId(current), { atPeriodEnd: true });

    await this.prisma.$transaction(async (tx) => {
      await this.clearPending(tx, current.id);
      await this.lifecycle.applyWithin(tx, {
        subscriptionId: current.id,
        event: LIFECYCLE_EVENTS.cancel,
        reason: TRANSITION_REASONS.canceled,
      });
    }, LIFECYCLE_TRANSACTION);

    return this.view(userId);
  }

  private async upgrade(
    userId: string,
    current: SubscriptionWithPlan,
    plan: Plan,
    stripeId: string,
  ): Promise<MeSubscriptionView> {
    await this.stripe.updateSubscription(stripeId, {
      priceId: plan.stripePriceId,
      prorationBehavior: 'create_prorations',
    });

    await this.prisma.$transaction((tx) =>
      this.subscriptions.settlePendingChange(tx, current.id, plan.id, plan.cycle),
    );

    return this.view(userId);
  }

  private async hold(
    userId: string,
    current: SubscriptionWithPlan,
    plan: Plan,
    stripeId: string,
  ): Promise<MeSubscriptionView> {
    await this.stripe.updateSubscription(stripeId, {
      priceId: plan.stripePriceId,
      prorationBehavior: 'none',
    });

    await this.prisma.$transaction((tx) =>
      this.subscriptions.writePendingChange(tx, current.id, {
        pendingPlanId: plan.id,
        pendingCycle: plan.cycle,
      }),
    );

    return this.view(userId);
  }

  private async resume(
    userId: string,
    current: SubscriptionWithPlan,
    plan: Plan,
    stripeId: string,
  ): Promise<MeSubscriptionView> {
    if (plan.id !== current.planId) {
      throw new ValidationError('A cancelled subscription resumes only on the plan it is on', {
        planCode: current.plan.code,
      });
    }

    await this.stripe.updateSubscription(stripeId, { cancelAtPeriodEnd: false });

    await this.prisma.$transaction(
      (tx) =>
        this.lifecycle.applyWithin(tx, {
          subscriptionId: current.id,
          event: LIFECYCLE_EVENTS.resume,
          reason: TRANSITION_REASONS.resumed,
        }),
      LIFECYCLE_TRANSACTION,
    );

    return this.view(userId);
  }

  private clearPending(tx: Prisma.TransactionClient, id: string): Promise<unknown> {
    return this.subscriptions.writePendingChange(tx, id, {
      pendingPlanId: null,
      pendingCycle: null,
    });
  }

  private requireStripeId(subscription: SubscriptionWithPlan): string {
    if (!subscription.stripeSubscriptionId) {
      throw new ValidationError('This subscription has not reached Stripe yet', {
        subscriptionId: subscription.id,
      });
    }

    return subscription.stripeSubscriptionId;
  }

  private async requireCurrent(userId: string): Promise<SubscriptionWithPlan> {
    const current = await this.subscriptions.findCurrentWithPlan(userId);

    if (!current) throw new NotFoundError('This account has no current subscription', { userId });

    return current;
  }

  private async requireActivePlan(choice: PlanChoice): Promise<Plan> {
    const plan = await this.plans.findActive(this.prisma, choice.planCode, choice.cycle);

    if (!plan) throw new NotFoundError('No such active plan', { ...choice });

    return plan;
  }
}
