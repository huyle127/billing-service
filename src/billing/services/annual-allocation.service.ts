import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock';
import { AppConfigService } from '@/common/config/app-config.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ALLOCATION_REASONS } from '../billing.constants';
import {
  SubscriptionRepository,
  SubscriptionWithPlan,
} from '../repositories/subscription.repository';
import { nextCreditAt } from './credit-schedule';
import { SubscriptionAllocationService } from './subscription-allocation.service';

export interface AllocationRunSummary {
  subscriptions: number;
  grants: number;
}

@Injectable()
export class AnnualAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly allocation: SubscriptionAllocationService,
    private readonly clock: Clock,
    private readonly config: AppConfigService,
  ) {}

  async run(): Promise<AllocationRunSummary> {
    const now = this.clock.now();
    const due = await this.subscriptions.findDueForCredit(now, this.config.allocationBatchSize);
    let grants = 0;

    for (const subscription of due) {
      grants += await this.catchUp(subscription, now);
    }

    return { subscriptions: due.length, grants };
  }

  private async catchUp(subscription: SubscriptionWithPlan, now: Date): Promise<number> {
    const boundary = subscription.paidThroughAt;
    let month = subscription.nextCreditAt;

    if (!boundary || !month) return 0;

    let grants = 0;

    while (month <= now && month < boundary) {
      const next = nextCreditAt(month, boundary);

      await this.grantMonth(subscription, month, next);

      month = next;
      grants += 1;
    }

    return grants;
  }

  private grantMonth(subscription: SubscriptionWithPlan, month: Date, next: Date): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      await this.allocation.grantMonth(tx, {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        monthlyCredits: subscription.plan.monthlyCredits,
        month,
        reason: ALLOCATION_REASONS.annualCron,
      });

      await this.subscriptions.advanceNextCreditAt(tx, subscription.id, next);
    });
  }
}
