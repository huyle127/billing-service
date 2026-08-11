import { Injectable } from '@nestjs/common';
import { NotFoundError } from '../../common/errors/domain.exception';
import { CreditService } from '../../credit/services/credit.service';
import { LedgerBalances } from '../../credit/services/draw-split';
import { UserService } from '../../user/services/user.service';
import { HISTORY_PAGE } from '../billing.constants';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { HistoryPage, HistoryService } from './history.service';

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
  history: HistoryPage;
}

@Injectable()
export class AdminBillingViewService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly credit: CreditService,
    private readonly users: UserService,
    private readonly history: HistoryService,
  ) {}

  async of(userId: string, cursor?: string): Promise<AdminBillingView> {
    const user = await this.users.findById(userId);

    if (!user) throw new NotFoundError('This user does not exist', { userId });

    const subscription = await this.subscriptions.findLatestByUserId(userId);
    const balances = await this.credit.balances(userId);
    const history = await this.history.page(userId, {
      limit: HISTORY_PAGE.adminLimit,
      cursor,
    });

    if (!subscription) return { userId, subscription: null, balances, history };

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
      history,
    };
  }
}
