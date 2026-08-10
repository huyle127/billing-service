import { Injectable } from '@nestjs/common';
import { CustomerCreatedHandler } from './customer-created.handler';
import { InvoicePaidHandler } from './invoice-paid.handler';
import { InvoicePaymentFailedHandler } from './invoice-payment-failed.handler';
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
  ) {
    this.byEventType = new Map(
      [
        subscriptionCreated,
        subscriptionUpdated,
        subscriptionDeleted,
        customerCreated,
        invoicePaid,
        invoicePaymentFailed,
      ].map(
        (handler) => [handler.eventType, handler],
      ),
    );
  }

  handlerFor(eventType: string): WebhookHandler | undefined {
    return this.byEventType.get(eventType);
  }
}
