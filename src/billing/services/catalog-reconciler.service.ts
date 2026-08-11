import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '@/common/config/app-config.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AddonPackageRepository } from '../repositories/addon-package.repository';
import { PlanRepository } from '../repositories/plan.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';

export interface MigrationRunSummary {
  migrated: number;
  orphans: string[];
}

@Injectable()
export class CatalogReconcilerService {
  private readonly logger = new Logger(CatalogReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly plans: PlanRepository,
    private readonly packages: AddonPackageRepository,
    private readonly stripe: StripeService,
    private readonly config: AppConfigService,
  ) {}

  async run(): Promise<MigrationRunSummary> {
    const migrated = await this.migrateSubscribers();
    const orphans = await this.reportOrphanPrices();

    return { migrated, orphans };
  }

  async migrateSubscribers(): Promise<number> {
    const mispriced = await this.subscriptions.findMispriced(this.config.catalogBatchSize);
    let migrated = 0;

    for (const subscription of mispriced) {
      await this.stripe.updateSubscription(subscription.stripeSubscriptionId, {
        priceId: subscription.targetPriceId,
        prorationBehavior: 'none',
      });
      await this.subscriptions.writeStripePriceId(subscription.id, subscription.targetPriceId);
      migrated += 1;
    }

    return migrated;
  }

  async reportOrphanPrices(): Promise<string[]> {
    const codes = [
      ...(await this.plans.listCodes(this.prisma)),
      ...(await this.packages.listCodes(this.prisma)),
    ].map((row) => row.code);
    const known = await this.knownPriceIds();
    const orphans: string[] = [];

    for (const code of new Set(codes)) {
      const prices = await this.stripe.findPricesByPlanCode(code);
      orphans.push(...prices.filter((price) => price.active && !known.has(price.id)).map((p) => p.id));
    }

    if (orphans.length > 0) {
      this.logger.warn(`Stripe prices with no catalog row: ${orphans.join(', ')}`);
    }

    return orphans;
  }

  private async knownPriceIds(): Promise<Set<string>> {
    const plans = await this.plans.listAll(this.prisma);
    const packages = await this.packages.listAll(this.prisma);

    return new Set([...plans, ...packages].map((row) => row.stripePriceId));
  }
}
