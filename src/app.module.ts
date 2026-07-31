import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AddonsModule } from './addons/addons.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import {
  RateLimitModule,
  UserRateLimitModule,
} from './common/throttling/throttling.module';
import { CreditsApiModule } from './credits/credits-api.module';
import { CreditsModule } from './credits/credits.module';
import { CustomersModule } from './customers/customers.module';
import { HealthController } from './health/health.controller';
import { HistoryModule } from './history/history.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProviderModule } from './provider/provider.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Registers the `@Cron` entry points in `ReconciliationModule`. The jobs
    // themselves are plain services whose `run()` a test calls directly, so
    // scheduling is the only thing this adds.
    ScheduleModule.forRoot(),
    PrismaModule,
    CatalogModule,
    CreditsModule,
    ProviderModule,
    // Before `AuthModule`, deliberately. Global guards run in the order their
    // providers are registered, and the address-keyed tiers — the `/auth`
    // limit and the default ceiling — must bound callers the JWT guard would
    // otherwise refuse first. A request rejected before it is counted is a
    // request that is not limited at all.
    RateLimitModule,
    // Binds the global JWT guard, so everything registered after it is
    // protected unless a route is explicitly `@Public`.
    AuthModule,
    // After `AuthModule`, equally deliberately: the per-user tiers count
    // against the principal the JWT guard puts on the request. Imported
    // earlier, they would find none and silently count per address instead —
    // still limiting, but not what the tier claims to limit.
    UserRateLimitModule,
    CustomersModule,
    SubscriptionsModule,
    PaymentsModule,
    PaymentMethodsModule,
    AddonsModule,
    CreditsApiModule,
    HistoryModule,
    WebhooksModule,
    ReconciliationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
