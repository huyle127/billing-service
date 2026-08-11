import { Injectable } from '@nestjs/common';
import { CustomerCreatedHandler } from './customer-created.handler';
import { InvoicePaidHandler } from './invoice-paid.handler';
import { InvoicePaymentFailedHandler } from './invoice-payment-failed.handler';
import { PaymentIntentPaymentFailedHandler } from './payment-intent-payment-failed.handler';
import { PaymentIntentSucceededHandler } from './payment-intent-succeeded.handler';
import { PaymentMethodAttachedHandler } from './payment-method-attached.handler';
import { PaymentMethodDetachedHandler } from './payment-method-detached.handler';
import { SubscriptionCreatedHandler } from './subscription-created.handler';
import { SubscriptionDeletedHandler } from './subscription-deleted.handler';
import { SubscriptionUpdatedHandler } from './subscription-updated.handler';
import { WebhookHandler } from './webhook-handler.interface';

@Injectable()
export class WebhookHandlerRegistry {
  private readonly byEventType: Map<string, WebhookHandler>;

  constructor(
    customerCreated: CustomerCreatedHandler,
    subscriptionCreated: SubscriptionCreatedHandler,
    subscriptionUpdated: SubscriptionUpdatedHandler,
    subscriptionDeleted: SubscriptionDeletedHandler,
    invoicePaid: InvoicePaidHandler,
    invoicePaymentFailed: InvoicePaymentFailedHandler,
    paymentMethodAttached: PaymentMethodAttachedHandler,
    paymentMethodDetached: PaymentMethodDetachedHandler,
    paymentIntentSucceeded: PaymentIntentSucceededHandler,
    paymentIntentPaymentFailed: PaymentIntentPaymentFailedHandler,
  ) {
    this.byEventType = new Map(
      [
        subscriptionCreated,
        subscriptionUpdated,
        subscriptionDeleted,
        customerCreated,
        invoicePaid,
        invoicePaymentFailed,
        paymentMethodAttached,
        paymentMethodDetached,
        paymentIntentSucceeded,
        paymentIntentPaymentFailed,
      ].map(
        (handler) => [handler.eventType, handler],
      ),
    );
  }

  handlerFor(eventType: string): WebhookHandler | undefined {
    return this.byEventType.get(eventType);
  }
}
