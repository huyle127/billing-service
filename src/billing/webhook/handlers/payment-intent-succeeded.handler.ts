import { Injectable } from '@nestjs/common';
import { CreditLedger, PaymentStatus, Prisma } from '@prisma/client';
import { CreditService } from '../../../credit/services/credit.service';
import { ALLOCATION_KEYS, ALLOCATION_REASONS } from '../../billing.constants';
import { PaymentTransactionRepository } from '../../repositories/payment-transaction.repository';
import { PAYMENT_STATUSES } from '../../stripe/stripe.constants';
import { StripePayment, StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { PurchaseResolutionService } from '../services/purchase-resolution.service';
import { OUTCOME_STATUSES, RESOLVED, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { Resolution, WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

const COMPLETED: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

@Injectable()
export class PaymentIntentSucceededHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.paymentIntentSucceeded;

  constructor(
    private readonly purchases: PurchaseResolutionService,
    private readonly payments: PaymentTransactionRepository,
    private readonly credit: CreditService,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    const lookup = await this.purchases.retrieveFor(event);

    if (lookup.status !== RESOLVED) return lookup;

    return { status: RESOLVED, apply: (tx) => this.grant(tx, lookup.payment, event) };
  }

  private async grant(
    tx: Prisma.TransactionClient,
    payment: StripePayment,
    event: StripeWebhookEvent,
  ): Promise<WebhookOutcome> {
    if (payment.status !== PAYMENT_STATUSES.succeeded) return COMPLETED;

    const resolved = await this.purchases.purchaseWithin(tx, payment);

    if (resolved.status === OUTCOME_STATUSES.deferred) return resolved;
    if (resolved.status !== RESOLVED) return COMPLETED;

    const { purchase } = resolved;

    await this.credit.allocate(tx, purchase.userId, {
      ledger: CreditLedger.ADDON,
      amount: purchase.addonPackage.credits,
      idempotencyKey: ALLOCATION_KEYS.purchase(purchase.id),
      replacing: false,
      reason: ALLOCATION_REASONS.addonPurchased,
    });

    await this.payments.settlePurchase(
      tx,
      purchase.id,
      PaymentStatus.SUCCEEDED,
      event.createdAt,
    );

    return COMPLETED;
  }
}
