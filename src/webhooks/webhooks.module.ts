import { Module } from '@nestjs/common';
import { AddonsModule } from '../addons/addons.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CreditsModule } from '../credits/credits.module';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProviderModule } from '../provider/provider.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CheckoutCompletedHandler } from './handlers/checkout-completed.handler';
import { InvoicePaidHandler } from './handlers/invoice-paid.handler';
import { InvoicePaymentFailedHandler } from './handlers/invoice-payment-failed.handler';
import { PaymentMethodHandler } from './handlers/payment-method.handler';
import { SubscriptionEndedHandler } from './handlers/subscription-ended.handler';
import { SubscriptionUpdatedHandler } from './handlers/subscription-updated.handler';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    AddonsModule,
    CatalogModule,
    CreditsModule,
    PaymentMethodsModule,
    PaymentsModule,
    ProviderModule,
    SubscriptionsModule,
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    InvoicePaidHandler,
    InvoicePaymentFailedHandler,
    CheckoutCompletedHandler,
    SubscriptionUpdatedHandler,
    SubscriptionEndedHandler,
    PaymentMethodHandler,
  ],
  exports: [WebhookService],
})
export class WebhooksModule {}
