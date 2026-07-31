import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../common/prisma-errors';
import { Prisma } from '../generated/prisma/client';
import { PaymentStatus, PaymentType } from '../generated/prisma/enums';
import type { PaymentModel } from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';

type TransactionClient = Prisma.TransactionClient;

interface RecordPaymentCommon {
  userId: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  failureReason?: string;
}

export interface RecordRecurringPaymentInput extends RecordPaymentCommon {
  subscriptionId: string;
  providerInvoiceId: string;
  providerPaymentIntentId?: string;
  /** The provider's attempt count for this invoice, mirrored as reported. */
  attemptNumber?: number;
}

export interface RecordAddonPaymentInput extends RecordPaymentCommon {
  addonPurchaseId: string;
  providerPaymentIntentId: string;
}

export interface RecordedPayment {
  payment: PaymentModel;
  /** False when this attempt had already been recorded. */
  created: boolean;
}

export interface PaymentHistoryQuery {
  /** Scopes to payments attributable to one Product, through their owner. */
  productId?: string;
}

/**
 * Payment records: one row per attempt, successful or failed.
 *
 * A payment belongs to a Subscription or to an add-on purchase and never to
 * both, which is why there are two recording methods rather than one with two
 * optional links. The database enforces the same thing with a check constraint,
 * so a future caller cannot get it wrong quietly.
 *
 * Recording is idempotent against the provider's identifiers: a redelivered
 * event re-reports the attempt it already reported, and the unique index is what
 * decides rather than a prior lookup.
 */
@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A recurring subscription payment, success or failure.
   *
   * Failures are as much a payment record as successes: dunning is observable
   * locally only because every attempt left one behind.
   */
  recordRecurringPayment(
    input: RecordRecurringPaymentInput,
    tx?: TransactionClient,
  ): Promise<RecordedPayment> {
    return this.record(
      {
        userId: input.userId,
        subscriptionId: input.subscriptionId,
        type: PaymentType.SUBSCRIPTION_RECURRING,
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        providerInvoiceId: input.providerInvoiceId,
        providerPaymentIntentId: input.providerPaymentIntentId,
        attemptNumber: input.attemptNumber,
        failureReason: input.failureReason,
      },
      {
        providerInvoiceId: input.providerInvoiceId,
        attemptNumber: input.attemptNumber ?? null,
      },
      tx,
    );
  }

  /**
   * A one-time add-on payment. Linked to the purchase, never to a Subscription:
   * buying credit neither creates nor modifies a subscription.
   */
  recordAddonPayment(
    input: RecordAddonPaymentInput,
    tx?: TransactionClient,
  ): Promise<RecordedPayment> {
    return this.record(
      {
        userId: input.userId,
        addonPurchaseId: input.addonPurchaseId,
        type: PaymentType.ADDON_ONE_TIME,
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        providerPaymentIntentId: input.providerPaymentIntentId,
        failureReason: input.failureReason,
      },
      { providerPaymentIntentId: input.providerPaymentIntentId },
      tx,
    );
  }

  /**
   * Every attempt for a user, newest first, optionally narrowed to one Product.
   *
   * Payments carry no `productId` of their own — they are attributable through
   * the subscription or the purchase they belong to, which keeps the Product a
   * fact of one place rather than copied onto every money row.
   */
  listPaymentHistory(
    userId: string,
    query: PaymentHistoryQuery = {},
  ): Promise<PaymentModel[]> {
    return this.prisma.payment.findMany({
      where: {
        userId,
        ...(query.productId
          ? {
              OR: [
                { subscription: { productId: query.productId } },
                { addonPurchase: { productId: query.productId } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async record(
    data: Prisma.PaymentUncheckedCreateInput,
    identity: Prisma.PaymentWhereInput,
    tx?: TransactionClient,
  ): Promise<RecordedPayment> {
    const client = tx ?? this.prisma;

    const existing = await client.payment.findFirst({ where: identity });
    if (existing) {
      return { payment: existing, created: false };
    }

    try {
      return { payment: await client.payment.create({ data }), created: true };
    } catch (error) {
      if (!isUniqueViolation(error) || tx) {
        // Inside a caller's transaction the violation has to propagate: nothing
        // can be read from an aborted transaction, and the caller's other
        // effects were predicated on this record.
        throw error;
      }
      const winner = await this.prisma.payment.findFirst({ where: identity });
      if (!winner) {
        throw error;
      }
      return { payment: winner, created: false };
    }
  }
}
