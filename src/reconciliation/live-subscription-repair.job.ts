import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from '../subscriptions/provisioning.service';
import { LIVE_SUBSCRIPTION_STATUSES } from '../subscriptions/subscription-status';
import type { ReconciliationJob } from './reconciliation-job';

export interface LiveSubscriptionRepairReport {
  /** `(user, product)` pairs found holding only terminal rows. */
  found: number;
  repaired: number;
  failed: number;
}

interface StrandedPair {
  userId: string;
  productId: string;
}

/**
 * Gives a user who has ended up with no live Subscription exactly one Free one.
 *
 * A failed transition can leave a user with no entitlement at all — the Pro row
 * out of the live set and the replacement never written — and no other
 * mechanism notices, because every ordinary path starts from a live row that in
 * this state does not exist.
 *
 * Three properties matter more than the repair itself:
 *
 * - It creates a **new** row and never revives a terminal one. That follows
 *   from delegating to {@link ProvisioningService}, which is the only writer of
 *   a Free row and does not know how to revive anything.
 * - It writes **no credit grant**. The repaired subscription's credits arrive
 *   through the standing allocation routine on its own `$0 invoice.paid`, the
 *   same way every other Free subscription's do (design D4b). A grant written
 *   here would be a second allocation path for the same period.
 * - Credits that expired when the Pro subscription departed **stay expired**.
 *   Repair restores entitlement, not history; nothing here reverses a ledger
 *   movement, and add-on grants stay preserved-and-frozen under the derived
 *   rule.
 */
@Injectable()
export class LiveSubscriptionRepairJob implements ReconciliationJob<LiveSubscriptionRepairReport> {
  readonly name = 'live-subscription-repair' as const;
  private readonly logger = new Logger(LiveSubscriptionRepairJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Cron(CronExpression.EVERY_6_HOURS)
  async runScheduled(): Promise<void> {
    const report = await this.run();
    if (report.repaired > 0 || report.failed > 0) {
      this.logger.log(
        `Live-subscription repair: repaired ${report.repaired} of ` +
          `${report.found}, failed ${report.failed}.`,
      );
    }
  }

  async run(): Promise<LiveSubscriptionRepairReport> {
    const stranded = await this.findStranded();

    const report: LiveSubscriptionRepairReport = {
      found: stranded.length,
      repaired: 0,
      failed: 0,
    };

    for (const pair of stranded) {
      try {
        // Idempotent, and it re-checks for a live row itself. A pair that
        // stopped being stranded between the query and here is answered from
        // the existing row rather than given a second one, and the one-live-row
        // index is the backstop if two instances arrive together.
        await this.provisioning.provisionFreeSubscription(
          pair.userId,
          pair.productId,
        );
        report.repaired += 1;
      } catch (error) {
        report.failed += 1;
        this.logger.error(
          `Could not repair user ${pair.userId} on product ${pair.productId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return report;
  }

  /**
   * `(user, product)` pairs that hold Subscription rows but none live.
   *
   * Raw SQL because the condition is an aggregate over each group — "has rows,
   * none of them live" — which is a `HAVING` clause, not something the query
   * builder expresses. A user with no rows at all for a product was never
   * provisioned for it and is not this job's business.
   */
  private findStranded(): Promise<StrandedPair[]> {
    return this.prisma.$queryRawUnsafe<StrandedPair[]>(
      `SELECT "user_id" AS "userId", "product_id" AS "productId"
         FROM "subscriptions"
        GROUP BY "user_id", "product_id"
       HAVING count(*) FILTER (WHERE "status"::text = ANY($1::text[])) = 0
        ORDER BY "user_id", "product_id"`,
      [...LIVE_SUBSCRIPTION_STATUSES],
    );
  }
}
