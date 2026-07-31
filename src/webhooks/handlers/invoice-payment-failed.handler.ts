import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentStatus,
  SubscriptionStatus,
} from '../../generated/prisma/enums';
import { PaymentsService } from '../../payments/payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProviderInvoice } from '../../provider/billing-provider';
import { isLive } from '../../subscriptions/subscription-status';
import type { WebhookOutcome } from '../webhook.service';

/**
 * `invoice.payment_failed` — dunning as **observation**.
 *
 * The subscription enters the grace period and the provider's attempt state is
 * mirrored so the retry policy is visible locally. Nothing here schedules a
 * retry, and nothing here ends the subscription: Stripe owns both the schedule
 * and the final cancellation, however long it takes to reach one (C2).
 *
 * Credit is neither granted nor expired. A past-due subscription's credits are
 * frozen by the derived spendability rule, and freezing is not destructive —
 * the same rows become spendable the moment payment recovers.
 */
@Injectable()
export class InvoicePaymentFailedHandler {
  private readonly logger = new Logger(InvoicePaymentFailedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  async handle(invoice: ProviderInvoice): Promise<WebhookOutcome> {
    if (!invoice.providerSubscriptionId) {
      return 'ignored';
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: invoice.providerSubscriptionId },
      select: { id: true, userId: true, status: true },
    });

    if (!subscription || !isLive(subscription.status)) {
      this.logger.log(
        `Failed invoice ${invoice.id} references no live local subscription; ` +
          `recorded and ignored.`,
      );
      return 'ignored';
    }

    await this.prisma.$transaction(async (tx) => {
      // Every attempt leaves a record, which is the only reason the retry
      // history is visible locally at all.
      await this.payments.recordRecurringPayment(
        {
          userId: subscription.userId,
          subscriptionId: subscription.id,
          amount: invoice.amountDue,
          currency: invoice.currency,
          status: PaymentStatus.FAILED,
          providerInvoiceId: invoice.id,
          providerPaymentIntentId: invoice.paymentIntentId ?? undefined,
          attemptNumber: invoice.attemptCount,
          failureReason: invoice.failureReason ?? undefined,
        },
        tx,
      );

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.PAST_DUE,
          // Mirrored from the provider, for observation only.
          paymentAttemptCount: invoice.attemptCount,
          nextPaymentAttemptAt: invoice.nextPaymentAttemptAt,
        },
      });
    });

    return 'processed';
  }
}
