import { Injectable } from '@nestjs/common';
import { PaymentKind, PaymentStatus, Prisma } from '@prisma/client';

export interface InvoicePayment {
  userId: string;
  stripeInvoiceId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

@Injectable()
export class PaymentTransactionRepository {
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
}
