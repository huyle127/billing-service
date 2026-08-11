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

  listActive(tx: Prisma.TransactionClient): Promise<Plan[]> {
    return tx.plan.findMany({ where: { active: true }, orderBy: [{ code: 'asc' }, { cycle: 'asc' }] });
  }

  listAll(tx: Prisma.TransactionClient): Promise<Plan[]> {
    return tx.plan.findMany({ orderBy: [{ code: 'asc' }, { cycle: 'asc' }] });
  }

  listCodes(tx: Prisma.TransactionClient): Promise<{ code: string }[]> {
    return tx.plan.findMany({ distinct: ['code'], select: { code: true } });
  }

  findWithProductByCode(tx: Prisma.TransactionClient, code: string): Promise<Plan | null> {
    return tx.plan.findFirst({ where: { code, stripeProductId: { not: null } } });
  }

  create(tx: Prisma.TransactionClient, data: Prisma.PlanUncheckedCreateInput): Promise<Plan> {
    return tx.plan.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.PlanUncheckedUpdateInput,
  ): Promise<Plan> {
    return tx.plan.update({ where: { id }, data });
  }
}
