import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { Clock } from '../../common/clock/clock';
import { NotFoundError } from '../../common/errors/domain.exception';
import { CreditService } from '../../credit/services/credit.service';
import { ALLOCATION_REASONS, FREE_PLAN } from '../billing.constants';
import { BillingCustomerRepository } from '../repositories/billing-customer.repository';
import { PlanRepository } from '../repositories/plan.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { SubscriptionAllocationService } from './subscription-allocation.service';

@Injectable()
export class EntitlementService {
  constructor(
    private readonly plans: PlanRepository,
    private readonly customers: BillingCustomerRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly credit: CreditService,
    private readonly allocation: SubscriptionAllocationService,
    private readonly clock: Clock,
  ) {}

  async grantOnRegistration(tx: Prisma.TransactionClient, user: User): Promise<void> {
    const plan = await this.plans.findActive(tx, FREE_PLAN.code, FREE_PLAN.cycle);

    if (!plan) {
      throw new NotFoundError('No active Free plan is configured', { ...FREE_PLAN });
    }

    const startedAt = this.clock.now();

    await this.customers.create(tx, user.id);

    const subscription = await this.subscriptions.createFree(tx, {
      userId: user.id,
      planId: plan.id,
      cycle: FREE_PLAN.cycle,
      startedAt,
    });

    await this.credit.createWallet(tx, user.id);
    await this.allocation.grantMonth(tx, {
      userId: user.id,
      subscriptionId: subscription.id,
      monthlyCredits: plan.monthlyCredits,
      month: startedAt,
      reason: ALLOCATION_REASONS.registration,
    });
  }
}
