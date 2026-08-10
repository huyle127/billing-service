import { Injectable } from '@nestjs/common';
import { CreditLedger, Prisma } from '@prisma/client';
import { CreditService } from '../../credit/services/credit.service';
import { ALLOCATION_KEYS } from '../billing.constants';

export interface MonthlyGrant {
  userId: string;
  subscriptionId: string;
  monthlyCredits: number;
  month: Date;
  reason: string;
}

@Injectable()
export class SubscriptionAllocationService {
  constructor(private readonly credit: CreditService) {}

  async grantMonth(tx: Prisma.TransactionClient, grant: MonthlyGrant): Promise<void> {
    await this.credit.allocate(tx, grant.userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: grant.monthlyCredits,
      idempotencyKey: ALLOCATION_KEYS.month(grant.subscriptionId, grant.month),
      replacing: false,
      reason: grant.reason,
    });
  }
}
