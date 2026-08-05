import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { StripeModule } from './billing/stripe/stripe.module';
import { ClockModule } from './common/clock/clock.module';
import { AppConfigModule } from './common/config/config.module';
import { configurations } from './common/config/configuration';
import { MetricsModule } from './common/metrics/metrics.module';
import { PrismaModule } from './common/prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
    AppConfigModule,
    ScheduleModule.forRoot(),
    ClockModule,
    MetricsModule,
    PrismaModule,
    StripeModule,
  ],
})
export class AppModule {}
