import { Injectable } from '@nestjs/common';
import { BillingCycle, Plan, Prisma } from '@prisma/client';

@Injectable()
export class PlanRepository {
  findActive(
    tx: Prisma.TransactionClient,
    code: string,
    cycle: BillingCycle,
  ): Promise<Plan | null> {
    return tx.plan.findFirst({ where: { code, cycle, active: true } });
  }

  findByStripePriceId(tx: Prisma.TransactionClient, stripePriceId: string): Promise<Plan | null> {
    return tx.plan.findUnique({ where: { stripePriceId } });
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<Plan | null> {
    return tx.plan.findUnique({ where: { id } });
  }
}
