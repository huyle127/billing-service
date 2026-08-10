import { Injectable } from '@nestjs/common';
import { Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { Clock } from '../../common/clock/clock';
import { NotFoundError } from '../../common/errors/domain.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditService } from '../../credit/services/credit.service';
import { FREE_PLAN, LIFECYCLE_TRANSACTION } from '../billing.constants';
import { PlanRepository } from '../repositories/plan.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import {
  AppliedTransition,
  LifecycleEvent,
  transitionFor,
  UNCHANGED,
} from './subscription-transitions';

export const APPLIED = 'applied';

export interface TransitionRequest {
  subscriptionId: string;
  event: LifecycleEvent;
  reason: string;
  stripeEventId?: string;
  stripeStatus?: string;
}

export type TransitionOutcome = typeof UNCHANGED | typeof APPLIED;

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly plans: PlanRepository,
    private readonly credit: CreditService,
    private readonly clock: Clock,
  ) {}

  apply(request: TransitionRequest): Promise<TransitionOutcome> {
    return this.prisma.$transaction(
      (tx) => this.applyWithin(tx, request),
      LIFECYCLE_TRANSACTION,
    );
  }

  async applyWithin(
    tx: Prisma.TransactionClient,
    request: TransitionRequest,
  ): Promise<TransitionOutcome> {
    const subscription = await this.subscriptions.findById(tx, request.subscriptionId);

    if (!subscription) {
      throw new NotFoundError('This subscription does not exist', {
        subscriptionId: request.subscriptionId,
      });
    }

    const transition = transitionFor(subscription.status, request.event);

    if (transition === UNCHANGED) return UNCHANGED;

    const at = this.clock.now();

    await this.record(tx, subscription, transition, request, at);
    await this.alignWalletWithStatus(tx, subscription, transition);

    if (transition.to === SubscriptionStatus.EXPIRED) {
      await this.credit.reset(tx, subscription.userId);
      await this.replaceWithFree(tx, subscription, at);
    }

    return APPLIED;
  }

  private async record(
    tx: Prisma.TransactionClient,
    subscription: Subscription,
    transition: AppliedTransition,
    request: TransitionRequest,
    at: Date,
  ): Promise<void> {
    await this.subscriptions.writeStatus(tx, subscription.id, {
      status: transition.to,
      stripeStatus: request.stripeStatus,
      canceledAt: transition.to === SubscriptionStatus.CANCELED ? at : undefined,
      endedAt: transition.to === SubscriptionStatus.EXPIRED ? at : undefined,
    });

    await this.subscriptions.appendEvent(tx, {
      subscriptionId: subscription.id,
      type: transition.records,
      reason: request.reason,
      stripeEventId: request.stripeEventId,
      occurredAt: at,
    });
  }

  private async alignWalletWithStatus(
    tx: Prisma.TransactionClient,
    subscription: Subscription,
    transition: AppliedTransition,
  ): Promise<void> {
    if (transition.to === SubscriptionStatus.PAST_DUE) {
      await this.credit.freeze(tx, subscription.userId);

      return;
    }

    if (subscription.status === SubscriptionStatus.PAST_DUE) {
      await this.credit.unfreeze(tx, subscription.userId);
    }
  }

  private async replaceWithFree(
    tx: Prisma.TransactionClient,
    expired: Subscription,
    at: Date,
  ): Promise<void> {
    const plan = await this.plans.findActive(tx, FREE_PLAN.code, FREE_PLAN.cycle);

    if (!plan) {
      throw new NotFoundError('No active Free plan is configured', { ...FREE_PLAN });
    }

    await this.subscriptions.createFree(tx, {
      userId: expired.userId,
      planId: plan.id,
      cycle: FREE_PLAN.cycle,
      startedAt: at,
    });
  }
}
