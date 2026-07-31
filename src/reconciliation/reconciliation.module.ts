import { Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '../common/clock';
import { CreditsModule } from '../credits/credits.module';
import { ProviderModule } from '../provider/provider.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CreditResetJob } from './credit-reset.job';
import { DriftDetectionJob } from './drift-detection.job';
import { LiveSubscriptionRepairJob } from './live-subscription-repair.job';
import { OrphanCleanupJob } from './orphan-cleanup.job';

/**
 * The four scheduled jobs, and nothing else. See `reconciliation-job.ts` for
 * why the set being exactly four is a requirement rather than an accident.
 */
@Module({
  imports: [CreditsModule, ProviderModule, SubscriptionsModule],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    CreditResetJob,
    OrphanCleanupJob,
    LiveSubscriptionRepairJob,
    DriftDetectionJob,
  ],
  exports: [
    CreditResetJob,
    OrphanCleanupJob,
    LiveSubscriptionRepairJob,
    DriftDetectionJob,
  ],
})
export class ReconciliationModule {}
