import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { CreditsModule } from '../credits/credits.module';
import { CustomersModule } from '../customers/customers.module';
import { ProviderModule } from '../provider/provider.module';
import { BillingStateService } from './billing-state.service';
import { ProvisioningService } from './provisioning.service';
import { SubscriptionHistoryService } from './subscription-history.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { SubscriptionRepository } from './subscription.repository';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
  imports: [CatalogModule, CreditsModule, CustomersModule, ProviderModule],
  controllers: [SubscriptionsController],
  providers: [
    ProvisioningService,
    SubscriptionLifecycleService,
    SubscriptionLookupService,
    SubscriptionHistoryService,
    SubscriptionRepository,
    BillingStateService,
  ],
  exports: [
    ProvisioningService,
    SubscriptionLifecycleService,
    SubscriptionLookupService,
    SubscriptionHistoryService,
    BillingStateService,
  ],
})
export class SubscriptionsModule {}
