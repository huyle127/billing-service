import { Module } from '@nestjs/common';
import { StripeSdkAdapter } from './adapters/stripe-sdk.adapter';
import { StripeService } from './interfaces/stripe-adapter.interface';

@Module({
  providers: [{ provide: StripeService, useClass: StripeSdkAdapter }],
  exports: [StripeService],
})
export class StripeModule {}
