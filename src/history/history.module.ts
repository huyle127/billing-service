import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { CreditsModule } from '../credits/credits.module';
import { PaymentsModule } from '../payments/payments.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { HistoryController } from './history.controller';

/**
 * Reads across three domains, so it owns none of them: payments, subscriptions,
 * and the credit ledger each answer for their own history and this module only
 * puts the three routes under one path.
 */
@Module({
  imports: [CatalogModule, CreditsModule, PaymentsModule, SubscriptionsModule],
  controllers: [HistoryController],
})
export class HistoryModule {}
