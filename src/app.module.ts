import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { StripeModule } from './billing/stripe/stripe.module';
import { WebhookModule } from './billing/webhook/webhook.module';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './common/config/config.module';
import { configurations } from './common/config/configuration';
import { MetricsModule } from './common/metrics/metrics.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { CreditModule } from './credit/credit.module';
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
    AppConfigModule,
    ScheduleModule.forRoot(),
    ClockModule,
    MetricsModule,
    PrismaModule,
    StripeModule,
    UserModule,
    AuthModule,
    BillingModule,
    CreditModule,
    WebhookModule,
  ],
})
export class AppModule {}
