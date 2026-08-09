import { Injectable } from '@nestjs/common';
import { BillingCustomer, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class BillingCustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(tx: Prisma.TransactionClient, userId: string): Promise<BillingCustomer> {
    return tx.billingCustomer.create({ data: { userId } });
  }

  findByUserId(userId: string): Promise<BillingCustomer | null> {
    return this.prisma.billingCustomer.findUnique({ where: { userId } });
  }

  async attachStripeCustomer(id: string, stripeCustomerId: string): Promise<void> {
    await this.prisma.billingCustomer.update({
      where: { id },
      data: { stripeCustomerId, syncAttempts: 0, syncError: null },
    });
  }

  async recordFailure(id: string, syncError: string, syncNextAttemptAt: Date): Promise<void> {
    await this.prisma.billingCustomer.update({
      where: { id },
      data: { syncAttempts: { increment: 1 }, syncError, syncNextAttemptAt },
    });
  }
}
