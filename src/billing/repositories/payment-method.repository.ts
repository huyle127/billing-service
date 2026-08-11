import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface PaymentMethodReference {
  userId: string;
  stripePaymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

@Injectable()
export class PaymentMethodRepository {
  constructor(private readonly prisma: PrismaService) {}

  listAttached(userId: string): Promise<PaymentMethod[]> {
    return this.prisma.paymentMethod.findMany({
      where: { userId, detachedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  countAttached(userId: string): Promise<number> {
    return this.prisma.paymentMethod.count({ where: { userId, detachedAt: null } });
  }

  countAttachedWithin(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    return tx.paymentMethod.count({ where: { userId, detachedAt: null } });
  }

  findChargeable(userId: string): Promise<PaymentMethod | null> {
    return this.prisma.paymentMethod.findFirst({
      where: { userId, detachedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  findAttached(userId: string, id: string): Promise<PaymentMethod | null> {
    return this.prisma.paymentMethod.findFirst({ where: { id, userId, detachedAt: null } });
  }

  record(
    tx: Prisma.TransactionClient,
    reference: PaymentMethodReference,
  ): Promise<PaymentMethod> {
    const { stripePaymentMethodId, isDefault, ...card } = reference;

    return tx.paymentMethod.upsert({
      where: { stripePaymentMethodId },
      create: { stripePaymentMethodId, isDefault, ...card },
      update: { ...card, detachedAt: null },
    });
  }

  async markDetached(
    tx: Prisma.TransactionClient,
    stripePaymentMethodId: string,
    at: Date,
  ): Promise<void> {
    await tx.paymentMethod.updateMany({
      where: { stripePaymentMethodId, detachedAt: null },
      data: { detachedAt: at, isDefault: false },
    });
  }
}
