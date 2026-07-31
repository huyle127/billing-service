import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Clock } from '../common/clock';
import { CLOCK } from '../common/clock';
import { PrismaService } from '../prisma/prisma.service';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type {
  BillingProvider,
  ProviderSubscription,
} from '../provider/billing-provider';
import { isLive } from '../subscriptions/subscription-status';
import type { ReconciliationJob } from './reconciliation-job';

/**
 * How old a provider subscription with no local row at all must be before it is
 * treated as an orphan.
 *
 * A paid subscription exists at Stripe from the moment checkout completes, but
 * its local row is written when `invoice.paid` arrives — so there is a window
 * in which "no local counterpart" means "not yet", not "never". Cancelling
 * inside that window would destroy a subscription the user has just paid for,
 * which is a far worse failure than leaving an orphan for another hour.
 *
 * This is a *selection* filter, not an idempotency key: the claim is still the
 * provider subscription's own terminal state, so the job stays safe to re-run
 * and safe under two instances regardless of this value.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface OrphanCleanupReport {
  customersExamined: number;
  cancelled: string[];
  /** Live at the provider, no local row, still inside the grace window. */
  deferred: number;
  failed: number;
}

/**
 * Cancels provider subscriptions that no live local row accounts for.
 *
 * **The one job that cannot start from a local query.** Every other job asks
 * "what do our rows say?"; this one asks "what does the provider think exists
 * that we do not?" — and the rows a local query would need are precisely the
 * ones that were never written. That is why the seam exposes
 * {@link BillingProvider.listCustomerSubscriptions} (design D7).
 *
 * The state it cleans up is reachable by construction, not by defect: Free
 * provisioning creates the provider subscription before the local row so that
 * no row ever lacks a `providerSubscriptionId`, and a transition cancels the
 * superseded provider subscription only *after* its commit. Both accept an
 * orphan on a crash as the deliberate trade (design R3), and this job is the
 * other half of that trade.
 */
@Injectable()
export class OrphanCleanupJob implements ReconciliationJob<OrphanCleanupReport> {
  readonly name = 'orphan-cleanup' as const;
  private readonly logger = new Logger(OrphanCleanupJob.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async runScheduled(): Promise<void> {
    const report = await this.run();
    if (report.cancelled.length > 0 || report.failed > 0) {
      this.logger.log(
        `Orphan cleanup: cancelled ${report.cancelled.length}, ` +
          `deferred ${report.deferred}, failed ${report.failed}.`,
      );
    }
  }

  async run(): Promise<OrphanCleanupReport> {
    const customers = await this.prisma.user.findMany({
      where: { stripeCustomerId: { not: null } },
      select: { id: true, stripeCustomerId: true },
      orderBy: { id: 'asc' },
    });

    const report: OrphanCleanupReport = {
      customersExamined: customers.length,
      cancelled: [],
      deferred: 0,
      failed: 0,
    };

    for (const customer of customers) {
      try {
        await this.reconcileCustomer(customer.stripeCustomerId!, report);
      } catch (error) {
        report.failed += 1;
        this.logger.error(
          `Orphan cleanup failed for customer ${customer.stripeCustomerId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return report;
  }

  private async reconcileCustomer(
    stripeCustomerId: string,
    report: OrphanCleanupReport,
  ): Promise<void> {
    const atProvider =
      await this.provider.listCustomerSubscriptions(stripeCustomerId);

    // Only what the provider still considers in force can be an orphan. One
    // already cancelled is already reconciled, and skipping it is what makes a
    // second run a no-op rather than a second cancellation.
    const inForce = atProvider.filter((s) => isLive(s.status));
    if (inForce.length === 0) {
      return;
    }

    const localRows = await this.prisma.subscription.findMany({
      where: { providerSubscriptionId: { in: inForce.map((s) => s.id) } },
      select: { providerSubscriptionId: true, status: true },
    });
    const localByProviderId = new Map(
      localRows.map((row) => [row.providerSubscriptionId, row.status]),
    );

    for (const subscription of inForce) {
      const localStatus = localByProviderId.get(subscription.id);

      if (localStatus !== undefined && isLive(localStatus)) {
        // A live row accounts for it. Never touched — this is the guard that
        // keeps the job from cancelling the subscription a user is paying for.
        continue;
      }

      if (localStatus === undefined && !this.isOldEnough(subscription)) {
        report.deferred += 1;
        continue;
      }

      await this.provider.cancelSubscriptionNow(subscription.id);
      report.cancelled.push(subscription.id);
      this.logger.log(
        `Cancelled orphaned provider subscription ${subscription.id}: ` +
          `${localStatus === undefined ? 'no local row' : `local row is ${localStatus}`}.`,
      );
    }
  }

  private isOldEnough(subscription: ProviderSubscription): boolean {
    if (!subscription.createdAt) {
      // A provider that does not report a creation time gives no basis for the
      // grace window. Deferring forever would leak orphans, so it is treated as
      // old enough and the local-row check above carries the safety.
      return true;
    }
    return (
      this.clock.now().getTime() - subscription.createdAt.getTime() >=
      ORPHAN_GRACE_MS
    );
  }
}
