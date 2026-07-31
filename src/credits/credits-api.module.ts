import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CreditsController } from './credits.controller';
import { CreditsModule } from './credits.module';

/**
 * The HTTP surface over credits.
 *
 * Separate from `CreditsModule` for one reason: the controller needs the live
 * subscription to derive spendability, and `SubscriptionsModule` already imports
 * `CreditsModule`. Putting the controller in `CreditsModule` would close that
 * loop into a circular dependency; putting it here keeps the credit domain
 * free of a back-edge to subscriptions.
 */
@Module({
  imports: [CatalogModule, CreditsModule, SubscriptionsModule],
  controllers: [CreditsController],
})
export class CreditsApiModule {}
