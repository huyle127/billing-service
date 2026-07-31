import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type {
  BillingProvider,
  ProviderSubscription,
} from '../provider/billing-provider';
import { SubscriptionStatus } from '../generated/prisma/enums';
import { LIVE_SUBSCRIPTION_STATUSES } from '../subscriptions/subscription-status';
import type { ReconciliationJob } from './reconciliation-job';

export type DriftKind =
  'missing-at-provider' | 'status' | 'period-start' | 'period-end' | 'price';

export interface Divergence {
  subscriptionId: string;
  providerSubscriptionId: string;
  kind: DriftKind;
  local: string | null;
  atProvider: string | null;
}

export interface DriftDetectionReport {
  examined: number;
  divergences: Divergence[];
  /** Subscriptions the provider could not be asked about. */
  unreadable: number;
}

/**
 * Compares local Subscription state against the provider and reports what
 * diverges. **Reads only.**
 *
 * Local status is a projection of Stripe's (design D0), so any divergence is by
 * definition a synchronisation defect on this side — a missed webhook, a
 * handler that returned early, a cancellation whose resulting provider state
 * was never applied locally. That is precisely why this job reports rather than
 * repairs: silently rewriting the local row would restore the projection and
 * erase the evidence that it stopped tracking, turning a visible bug into an
 * invisible one that recurs every period.
 *
 * "Stripe is the source of truth" is only a checkable claim if something checks
 * it. This is that something.
 */
@Injectable()
export class DriftDetectionJob implements ReconciliationJob<DriftDetectionReport> {
  readonly name = 'drift-detection' as const;
  private readonly logger = new Logger(DriftDetectionJob.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runScheduled(): Promise<void> {
    const report = await this.run();
    for (const divergence of report.divergences) {
      this.logger.warn(
        `Drift on subscription ${divergence.subscriptionId} ` +
          `(${divergence.providerSubscriptionId}): ${divergence.kind} — ` +
          `local ${divergence.local ?? 'null'}, ` +
          `provider ${divergence.atProvider ?? 'null'}.`,
      );
    }
  }

  async run(): Promise<DriftDetectionReport> {
    const local = await this.prisma.subscription.findMany({
      where: { status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
      include: { pricingOption: true },
      orderBy: { id: 'asc' },
    });

    const report: DriftDetectionReport = {
      examined: local.length,
      divergences: [],
      unreadable: 0,
    };

    for (const subscription of local) {
      let atProvider: ProviderSubscription | null;
      try {
        // A read. The only provider call this job makes.
        atProvider = await this.provider.getSubscription(
          subscription.providerSubscriptionId,
        );
      } catch (error) {
        report.unreadable += 1;
        this.logger.error(
          `Could not read provider subscription ` +
            `${subscription.providerSubscriptionId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      report.divergences.push(
        ...this.compare(
          {
            id: subscription.id,
            providerSubscriptionId: subscription.providerSubscriptionId,
            status: subscription.status,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            stripePriceId: subscription.pricingOption.stripePriceId,
          },
          atProvider,
        ),
      );
    }

    return report;
  }

  private compare(
    local: {
      id: string;
      providerSubscriptionId: string;
      status: SubscriptionStatus;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      stripePriceId: string;
    },
    atProvider: ProviderSubscription | null,
  ): Divergence[] {
    const at = (kind: DriftKind, a: string | null, b: string | null) => ({
      subscriptionId: local.id,
      providerSubscriptionId: local.providerSubscriptionId,
      kind,
      local: a,
      atProvider: b,
    });

    if (!atProvider) {
      return [at('missing-at-provider', local.status, null)];
    }

    const divergences: Divergence[] = [];

    if (atProvider.status !== local.status) {
      divergences.push(at('status', local.status, atProvider.status));
    }
    if (!sameInstant(local.currentPeriodStart, atProvider.currentPeriodStart)) {
      divergences.push(
        at(
          'period-start',
          iso(local.currentPeriodStart),
          iso(atProvider.currentPeriodStart),
        ),
      );
    }
    if (!sameInstant(local.currentPeriodEnd, atProvider.currentPeriodEnd)) {
      divergences.push(
        at(
          'period-end',
          iso(local.currentPeriodEnd),
          iso(atProvider.currentPeriodEnd),
        ),
      );
    }
    if (atProvider.priceId !== local.stripePriceId) {
      divergences.push(at('price', local.stripePriceId, atProvider.priceId));
    }

    return divergences;
  }
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.getTime() === b.getTime();
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}
