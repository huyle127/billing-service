import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ClockModule } from '../common/clock/clock.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CreditModule } from '../credit/credit.module';
import { UserModule } from '../user/user.module';
import { AddonPackageRepository } from './repositories/addon-package.repository';
import { BillingCustomerRepository } from './repositories/billing-customer.repository';
import { PaymentMethodRepository } from './repositories/payment-method.repository';
import { PaymentTransactionRepository } from './repositories/payment-transaction.repository';
import { PlanRepository } from './repositories/plan.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { InternalKeyGuard } from '../common/identity/internal-key.guard';
import { AdminBillingController } from './controllers/admin-billing.controller';
import { AdminCatalogController } from './controllers/admin-catalog.controller';
import { CatalogController } from './controllers/catalog.controller';
import { InternalController } from './controllers/internal.controller';
import { MeAddonController } from './controllers/me-addon.controller';
import { MePaymentMethodController } from './controllers/me-payment-method.controller';
import { MeSubscriptionController } from './controllers/me-subscription.controller';
import { AddonPurchaseService } from './services/addon-purchase.service';
import { MeSubscriptionService } from './services/me-subscription.service';
import { PaymentMethodService } from './services/payment-method.service';
import { AnnualAllocationSchedulerService } from './services/annual-allocation-scheduler.service';
import { AnnualAllocationService } from './services/annual-allocation.service';
import { AdminBillingViewService } from './services/admin-billing-view.service';
import { CatalogReconcilerSchedulerService } from './services/catalog-reconciler-scheduler.service';
import { CatalogReconcilerService } from './services/catalog-reconciler.service';
import { CatalogService } from './services/catalog.service';
import { EntitlementService } from './services/entitlement.service';
import { ProvisioningSchedulerService } from './services/provisioning-scheduler.service';
import { ProvisioningService } from './services/provisioning.service';
import { SubscriptionAllocationService } from './services/subscription-allocation.service';
import { SubscriptionLifecycleService } from './services/subscription-lifecycle.service';
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
  controllers: [
    InternalController,
    CatalogController,
    MeSubscriptionController,
    MePaymentMethodController,
    MeAddonController,
    AdminCatalogController,
    AdminBillingController,
  ],
  providers: [
    AddonPurchaseService,
    AnnualAllocationService,
    AnnualAllocationSchedulerService,
    InternalKeyGuard,
    AdminBillingViewService,
    CatalogService,
    CatalogReconcilerService,
    CatalogReconcilerSchedulerService,
    EntitlementService,
    MeSubscriptionService,
    PaymentMethodService,
    ProvisioningService,
    ProvisioningSchedulerService,
    SubscriptionAllocationService,
    SubscriptionLifecycleService,
    PlanRepository,
    AddonPackageRepository,
    PaymentMethodRepository,
    PaymentTransactionRepository,
    BillingCustomerRepository,
    SubscriptionRepository,
  ],
  exports: [
    AddonPackageRepository,
    CatalogService,
    CatalogReconcilerService,
    EntitlementService,
    ProvisioningService,
    SubscriptionAllocationService,
    SubscriptionLifecycleService,
    PlanRepository,
    PaymentMethodRepository,
    PaymentTransactionRepository,
    BillingCustomerRepository,
    SubscriptionRepository,
  ],
})
export class BillingModule {}
