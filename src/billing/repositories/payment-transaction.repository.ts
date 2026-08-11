import { Injectable } from '@nestjs/common';
import { AddonPackage, PaymentKind, PaymentStatus, PaymentTransaction, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface InvoicePayment {
  userId: string;
  stripeInvoiceId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

export interface AddonPurchase {
  userId: string;
  addonPackageId: string;
  amountCents: number;
  currency: string;
  description: string;
  occurredAt: Date;
}

export type PurchaseWithPackage = PaymentTransaction & { addonPackage: AddonPackage | null };

@Injectable()
export class PaymentTransactionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordInvoice(
    tx: Prisma.TransactionClient,
    payment: InvoicePayment,
  ): Promise<void> {
    const { stripeInvoiceId, ...fields } = payment;

    await tx.paymentTransaction.upsert({
      where: { stripeInvoiceId },
      create: { ...fields, stripeInvoiceId, kind: PaymentKind.SUBSCRIPTION },
      update: { status: fields.status, amountCents: fields.amountCents },
    });
  }

  openPurchase(purchase: AddonPurchase): Promise<PaymentTransaction> {
    return this.prisma.paymentTransaction.create({
      data: { ...purchase, kind: PaymentKind.ADDON, status: PaymentStatus.PENDING },
    });
  }

  attachPaymentIntent(id: string, stripePaymentIntentId: string): Promise<PaymentTransaction> {
    return this.prisma.paymentTransaction.update({
      where: { id },
      data: { stripePaymentIntentId },
    });
  }

  findPurchaseWithin(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PurchaseWithPackage | null> {
    return tx.paymentTransaction.findFirst({
      where: { id, kind: PaymentKind.ADDON },
      include: { addonPackage: true },
    });
  }

  async settlePurchase(
    tx: Prisma.TransactionClient,
    id: string,
    status: PaymentStatus,
    occurredAt: Date,
  ): Promise<void> {
    await tx.paymentTransaction.update({ where: { id }, data: { status, occurredAt } });
  }
}
