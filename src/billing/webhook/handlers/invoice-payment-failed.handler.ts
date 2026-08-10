import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { TRANSITION_REASONS } from '../../billing.constants';
import { PaymentTransactionRepository } from '../../repositories/payment-transaction.repository';
import { SubscriptionLifecycleService } from '../../services/subscription-lifecycle.service';
import { LIFECYCLE_EVENTS, UNCHANGED } from '../../services/subscription-transitions';
import { StripeInvoice, StripeSubscription, StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { InvoiceReadingService } from '../services/invoice-reading.service';
import { SubscriptionSyncService } from '../services/subscription-sync.service';
import { OUTCOME_STATUSES, RESOLVED, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { Resolution, WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

const COMPLETED: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

@Injectable()
export class InvoicePaymentFailedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.invoicePaymentFailed;

  constructor(
    private readonly sync: SubscriptionSyncService,
    private readonly reading: InvoiceReadingService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly payments: PaymentTransactionRepository,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    const lookup = await this.sync.retrieveForInvoice(event);

    if (lookup.status !== RESOLVED) return lookup;

    return {
      status: RESOLVED,
      apply: (tx) => this.dun(tx, lookup.invoice, lookup.retrieved, event),
    };
  }

  private async dun(
    tx: Prisma.TransactionClient,
    invoice: StripeInvoice,
    retrieved: StripeSubscription,
    event: StripeWebhookEvent,
  ): Promise<WebhookOutcome> {
    const synced = await this.sync.syncWithin(tx, retrieved);

    if (synced.status === OUTCOME_STATUSES.deferred) return synced;
    if (synced.status !== RESOLVED) return COMPLETED;

    const transition = await this.lifecycle.applyWithin(tx, {
      subscriptionId: synced.local.id,
      event: LIFECYCLE_EVENTS.pastDue,
      reason: TRANSITION_REASONS.pastDue,
      stripeEventId: event.id,
      stripeStatus: retrieved.status,
    });

    if (transition === UNCHANGED) return COMPLETED;

    if (this.reading.movesMoney(invoice)) {
      await this.payments.recordInvoice(tx, {
        userId: synced.local.userId,
        stripeInvoiceId: invoice.id,
        status: PaymentStatus.FAILED,
        amountCents: invoice.amountDue,
        currency: invoice.currency,
        occurredAt: event.createdAt,
      });
    }

    return COMPLETED;
  }
}
