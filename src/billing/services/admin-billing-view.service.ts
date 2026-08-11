import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../common/errors/domain.exception';
import { CreditService } from '../../credit/services/credit.service';
import { LedgerBalances } from '../../credit/services/draw-split';
import { UserService } from '../../user/services/user.service';
import { SubscriptionRepository } from '../repositories/subscription.repository';

export interface AdminBillingView {
  userId: string;
  subscription: {
    id: string;
    status: string;
    cycle: string;
    planCode: string;
    stripePriceId: string | null;
    paidThroughAt: Date | null;
  } | null;
  balances: LedgerBalances;
}

@Injectable()
export class AdminBillingViewService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly credit: CreditService,
    private readonly users: UserService,
  ) {}

  async of(userId: string): Promise<AdminBillingView> {
    const user = await this.users.findById(userId);

    if (!user) throw new NotFoundError('This user does not exist', { userId });

    const subscription = await this.subscriptions.findLatestByUserId(userId);
    const balances = await this.credit.balances(userId);

    if (!subscription) return { userId, subscription: null, balances };

    return {
      userId,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        cycle: subscription.cycle,
        planCode: subscription.plan.code,
        stripePriceId: subscription.stripePriceId,
        paidThroughAt: subscription.paidThroughAt,
      },
      balances,
    };
  }
}
