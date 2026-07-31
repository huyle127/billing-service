import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { creditPolicyOf } from '../catalog/credit-policy';
import type { Clock } from '../common/clock';
import { CLOCK } from '../common/clock';
import { isUniqueViolation } from '../common/prisma-errors';
import { creditPeriodFrom } from '../credits/credit-period';
import { CreditsService } from '../credits/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_SUBSCRIPTION_STATUSES } from '../subscriptions/subscription-status';
import type { ReconciliationJob } from './reconciliation-job';

export interface CreditResetReport {
  /** Subscriptions whose marker had fallen due. */
  due: number;
  /** Periods this run allocated. */
  granted: number;
  /** Periods another path had already claimed. */
  alreadyAllocated: number;
  failed: number;
}

/**
 * The monthly credit reset.
 *
 * **Required, not optional.** Pro Annual bills once a year and resets credits
 * monthly, so eleven of its twelve credit periods have no invoice to hang
 * allocation on (design D4, D7). Without this job an annual subscriber would
 * receive one month of credit for a year of payment.
 *
 * It allocates through {@link CreditsService.allocateSubscriptionCredits} — the
 * same routine the paid-invoice handler uses — so neither path needs to know
 * whether the other has run, and the unique index on
 * `(subscriptionId, creditPeriodStart)` is what decides a tie. That index is
 * load-bearing here rather than defensive: in month one of an annual year the
 * invoice and this job are both due for the same period.
 */
@Injectable()
export class CreditResetJob implements ReconciliationJob<CreditResetReport> {
  readonly name = 'credit-reset' as const;
  private readonly logger = new Logger(CreditResetJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runScheduled(): Promise<void> {
    const report = await this.run();
    if (report.granted > 0 || report.failed > 0) {
      this.logger.log(
        `Credit reset: ${report.granted} granted, ` +
          `${report.alreadyAllocated} already allocated, ${report.failed} failed.`,
      );
    }
  }

  async run(): Promise<CreditResetReport> {
    const due = await this.prisma.subscription.findMany({
      where: {
        // Not live means no entitlement, so nothing to reset. A terminal row
        // whose marker fell due is skipped rather than granted — this is the
        // filter that stops a cancelled subscription accruing credit forever.
        status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
        nextCreditResetAt: { not: null, lte: this.clock.now() },
      },
      include: { plan: true },
      orderBy: { id: 'asc' },
    });

    const report: CreditResetReport = {
      due: due.length,
      granted: 0,
      alreadyAllocated: 0,
      failed: 0,
    };

    for (const subscription of due) {
      // The marker *is* the new period's start, which is what keeps periods
      // tiling without gap or overlap across however many runs it takes.
      const periodStart = subscription.nextCreditResetAt!;
      const policy = creditPolicyOf(subscription.plan);
      const period = creditPeriodFrom(periodStart, policy);

      try {
        const created = await this.prisma.$transaction(async (tx) => {
          const allocation = await this.credits.allocateSubscriptionCredits(
            {
              userId: subscription.userId,
              productId: subscription.productId,
              subscriptionId: subscription.id,
              creditPeriodStart: period.start,
              creditPeriodEnd: period.end,
              amount: policy.creditsPerPeriod,
              relatedEvent: { type: this.name, id: subscription.id },
            },
            tx,
          );

          // In the same transaction as the grant, and only there. A run that
          // allocated nothing leaves the marker where it was, so the period is
          // retried rather than silently skipped.
          await tx.subscription.update({
            where: { id: subscription.id },
            data: { nextCreditResetAt: period.end },
          });

          return allocation.created;
        });

        if (created) {
          report.granted += 1;
        } else {
          report.alreadyAllocated += 1;
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Another instance, or the invoice handler, claimed this period
          // first. Its grant is the one that counts and it advanced the marker,
          // so this run has nothing left to do for this subscription.
          report.alreadyAllocated += 1;
          continue;
        }

        // One subscription's failure must not deny every later subscription its
        // credit period, and the marker is untouched so the next run retries.
        report.failed += 1;
        this.logger.error(
          `Credit reset failed for subscription ${subscription.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return report;
  }
}
