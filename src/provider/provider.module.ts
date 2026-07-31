import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BILLING_PROVIDER } from './billing-provider';
import { StripeBillingProvider } from './stripe-billing.provider';

@Module({
  providers: [
    {
      provide: BILLING_PROVIDER,
      useFactory: (config: ConfigService) => new StripeBillingProvider(config),
      inject: [ConfigService],
    },
  ],
  exports: [BILLING_PROVIDER],
})
export class ProviderModule {}
