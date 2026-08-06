import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { StripeModule } from './billing/stripe/stripe.module';
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
    CreditModule,
  ],
})
export class AppModule {}
