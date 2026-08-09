import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ClockModule } from '../common/clock/clock.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CreditModule } from '../credit/credit.module';
import { UserModule } from '../user/user.module';
import { BillingCustomerRepository } from './repositories/billing-customer.repository';
import { PlanRepository } from './repositories/plan.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { EntitlementService } from './services/entitlement.service';
import { ProvisioningSchedulerService } from './services/provisioning-scheduler.service';
import { ProvisioningService } from './services/provisioning.service';
import { StripeModule } from './stripe/stripe.module';

@Module({
  imports: [
    PrismaModule,
    StripeModule,
    ClockModule,
    CreditModule,
    UserModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    EntitlementService,
    ProvisioningService,
    ProvisioningSchedulerService,
    PlanRepository,
    BillingCustomerRepository,
    SubscriptionRepository,
  ],
  exports: [EntitlementService, ProvisioningService],
})
export class BillingModule {}
