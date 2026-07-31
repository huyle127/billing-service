import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { ProviderModule } from '../provider/provider.module';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';

@Module({
  imports: [CustomersModule, ProviderModule],
  controllers: [PaymentMethodsController],
  providers: [PaymentMethodsService],
  exports: [PaymentMethodsService],
})
export class PaymentMethodsModule {}
