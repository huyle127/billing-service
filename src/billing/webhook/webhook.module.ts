import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { BillingModule } from '../billing.module';
import { StripeModule } from '../stripe/stripe.module';
import { WebhookController } from './controllers/webhook.controller';
import { CustomerCreatedHandler } from './handlers/customer-created.handler';
import { InvoicePaidHandler } from './handlers/invoice-paid.handler';
import { InvoicePaymentFailedHandler } from './handlers/invoice-payment-failed.handler';
import { SubscriptionCreatedHandler } from './handlers/subscription-created.handler';
import { SubscriptionDeletedHandler } from './handlers/subscription-deleted.handler';
import { SubscriptionUpdatedHandler } from './handlers/subscription-updated.handler';
import { WebhookHandlerRegistry } from './handlers/webhook-handler.registry';
import { WebhookEventRepository } from './repositories/webhook-event.repository';
import { InvoiceReadingService } from './services/invoice-reading.service';
import { SubscriptionSyncService } from './services/subscription-sync.service';
import { WebhookService } from './services/webhook.service';

@Module({
  imports: [PrismaModule, ClockModule, StripeModule, BillingModule],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookEventRepository,
    WebhookHandlerRegistry,
    SubscriptionSyncService,
    InvoiceReadingService,
    CustomerCreatedHandler,
    SubscriptionCreatedHandler,
    SubscriptionUpdatedHandler,
    SubscriptionDeletedHandler,
    InvoicePaidHandler,
    InvoicePaymentFailedHandler,
  ],
})
export class WebhookModule {}
