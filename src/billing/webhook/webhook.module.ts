import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { CreditModule } from '../../credit/credit.module';
import { BillingModule } from '../billing.module';
import { StripeModule } from '../stripe/stripe.module';
import { WebhookController } from './controllers/webhook.controller';
import { CustomerCreatedHandler } from './handlers/customer-created.handler';
import { InvoicePaidHandler } from './handlers/invoice-paid.handler';
import { InvoicePaymentFailedHandler } from './handlers/invoice-payment-failed.handler';
import { PaymentIntentPaymentFailedHandler } from './handlers/payment-intent-payment-failed.handler';
import { PaymentIntentSucceededHandler } from './handlers/payment-intent-succeeded.handler';
import { PaymentMethodAttachedHandler } from './handlers/payment-method-attached.handler';
import { PaymentMethodDetachedHandler } from './handlers/payment-method-detached.handler';
import { SubscriptionCreatedHandler } from './handlers/subscription-created.handler';
import { SubscriptionDeletedHandler } from './handlers/subscription-deleted.handler';
import { SubscriptionUpdatedHandler } from './handlers/subscription-updated.handler';
import { WebhookHandlerRegistry } from './handlers/webhook-handler.registry';
import { WebhookEventRepository } from './repositories/webhook-event.repository';
import { InvoiceReadingService } from './services/invoice-reading.service';
import { PurchaseResolutionService } from './services/purchase-resolution.service';
import { SubscriptionSyncService } from './services/subscription-sync.service';
import { WebhookService } from './services/webhook.service';

@Module({
  imports: [PrismaModule, ClockModule, StripeModule, BillingModule, CreditModule],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookEventRepository,
    WebhookHandlerRegistry,
    SubscriptionSyncService,
    InvoiceReadingService,
    PurchaseResolutionService,
    CustomerCreatedHandler,
    SubscriptionCreatedHandler,
    SubscriptionUpdatedHandler,
    SubscriptionDeletedHandler,
    InvoicePaidHandler,
    InvoicePaymentFailedHandler,
    PaymentMethodAttachedHandler,
    PaymentMethodDetachedHandler,
    PaymentIntentSucceededHandler,
    PaymentIntentPaymentFailedHandler,
  ],
})
export class WebhookModule {}
