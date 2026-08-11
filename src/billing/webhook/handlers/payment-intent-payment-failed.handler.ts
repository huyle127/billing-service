import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PaymentTransactionRepository } from '../../repositories/payment-transaction.repository';
import { PAYMENT_STATUSES } from '../../stripe/stripe.constants';
import { StripePayment, StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { PurchaseResolutionService } from '../services/purchase-resolution.service';
import { OUTCOME_STATUSES, RESOLVED, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { Resolution, WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

const COMPLETED: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

@Injectable()
export class PaymentIntentPaymentFailedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.paymentIntentPaymentFailed;

  constructor(
    private readonly purchases: PurchaseResolutionService,
    private readonly payments: PaymentTransactionRepository,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    const lookup = await this.purchases.retrieveFor(event);

    if (lookup.status !== RESOLVED) return lookup;

    return { status: RESOLVED, apply: (tx) => this.fail(tx, lookup.payment, event) };
  }

  private async fail(
    tx: Prisma.TransactionClient,
    payment: StripePayment,
    event: StripeWebhookEvent,
  ): Promise<WebhookOutcome> {
    if (payment.status === PAYMENT_STATUSES.succeeded) return COMPLETED;

    const resolved = await this.purchases.purchaseWithin(tx, payment);

    if (resolved.status === OUTCOME_STATUSES.deferred) return resolved;
    if (resolved.status !== RESOLVED) return COMPLETED;

    await this.payments.settlePurchase(
      tx,
      resolved.purchase.id,
      PaymentStatus.FAILED,
      event.createdAt,
    );

    return COMPLETED;
  }
}
