import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { CreditsModule } from '../credits/credits.module';
import { CustomersModule } from '../customers/customers.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProviderModule } from '../provider/provider.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AddonsController } from './addons.controller';
import { AddonsService } from './addons.service';

@Module({
  imports: [
    CatalogModule,
    CreditsModule,
    CustomersModule,
    PaymentsModule,
    ProviderModule,
    SubscriptionsModule,
  ],
  controllers: [AddonsController],
  providers: [AddonsService],
  exports: [AddonsService],
})
export class AddonsModule {}
