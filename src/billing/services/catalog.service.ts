import { Injectable } from '@nestjs/common';
import { AddonPackage, BillingCycle, Plan } from '@prisma/client';
import { NotFoundError } from '@/common/errors/domain.exception';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DEFAULT_CURRENCY } from '../billing.constants';
import { PlanInUseError } from '../billing.errors';
import { AddonPackageRepository } from '../repositories/addon-package.repository';
import { PlanRepository } from '../repositories/plan.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { PriceInterval } from '../stripe/types/stripe.types';

export interface NewPlan {
  code: string;
  name: string;
  cycle: BillingCycle;
  monthlyCredits: number;
  amountCents: number;
  currency?: string;
}

export interface PlanRevision {
  name?: string;
  monthlyCredits?: number;
  amountCents?: number;
}

export interface NewAddonPackage {
  code: string;
  name: string;
  credits: number;
  amountCents: number;
  currency?: string;
}

export interface AddonPackageRevision {
  name?: string;
  credits?: number;
  amountCents?: number;
}

const INTERVALS: Record<BillingCycle, PriceInterval> = {
  [BillingCycle.MONTHLY]: 'month',
  [BillingCycle.ANNUAL]: 'year',
};

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanRepository,
    private readonly packages: AddonPackageRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly stripe: StripeService,
  ) {}

  listPlans(includeArchived = false): Promise<Plan[]> {
    return includeArchived ? this.plans.listAll(this.prisma) : this.plans.listActive(this.prisma);
  }

  listPackages(includeArchived = false): Promise<AddonPackage[]> {
    return includeArchived
      ? this.packages.listAll(this.prisma)
      : this.packages.listActive(this.prisma);
  }

  async createPlan(input: NewPlan): Promise<Plan> {
    const currency = input.currency ?? DEFAULT_CURRENCY;
    const productId = await this.productIdForPlan(input.code, input.name);
    const price = await this.stripe.createPrice({
      code: input.code,
      productId,
      unitAmount: input.amountCents,
      currency,
      interval: INTERVALS[input.cycle],
    });

    return this.plans.create(this.prisma, {
      ...input,
      currency,
      stripePriceId: price.id,
      stripeProductId: productId,
    });
  }

  async createPackage(input: NewAddonPackage): Promise<AddonPackage> {
    const currency = input.currency ?? DEFAULT_CURRENCY;
    const productId = await this.productIdForPackage(input.code, input.name);
    const price = await this.stripe.createPrice({
      code: input.code,
      productId,
      unitAmount: input.amountCents,
      currency,
      interval: null,
    });

    return this.packages.create(this.prisma, {
      ...input,
      currency,
      stripePriceId: price.id,
      stripeProductId: productId,
    });
  }

  async revisePlan(id: string, revision: PlanRevision): Promise<Plan> {
    const plan = await this.requirePlan(id);
    const amountCents = revision.amountCents;

    if (amountCents === undefined || amountCents === plan.amountCents) {
      return this.plans.update(this.prisma, id, revision);
    }

    const price = await this.stripe.createPrice({
      code: plan.code,
      productId: await this.productIdForPlan(plan.code, plan.name),
      unitAmount: amountCents,
      currency: plan.currency,
      interval: INTERVALS[plan.cycle],
    });

    await this.stripe.archivePrice(plan.stripePriceId);

    return this.plans.update(this.prisma, id, { ...revision, stripePriceId: price.id });
  }

  async revisePackage(id: string, revision: AddonPackageRevision): Promise<AddonPackage> {
    const pkg = await this.requirePackage(id);
    const amountCents = revision.amountCents;

    if (amountCents === undefined || amountCents === pkg.amountCents) {
      return this.packages.update(this.prisma, id, revision);
    }

    const price = await this.stripe.createPrice({
      code: pkg.code,
      productId: await this.productIdForPackage(pkg.code, pkg.name),
      unitAmount: amountCents,
      currency: pkg.currency,
      interval: null,
    });

    await this.stripe.archivePrice(pkg.stripePriceId);

    return this.packages.update(this.prisma, id, { ...revision, stripePriceId: price.id });
  }

  async archivePlan(id: string): Promise<Plan> {
    const plan = await this.requirePlan(id);
    const subscribers = await this.subscriptions.countActiveByPlanId(this.prisma, id);

    if (subscribers > 0) {
      throw new PlanInUseError('The plan still has active subscriptions', { planId: id, subscribers });
    }

    await this.stripe.archivePrice(plan.stripePriceId);

    return this.plans.update(this.prisma, id, { active: false });
  }

  async archivePackage(id: string): Promise<AddonPackage> {
    const pkg = await this.requirePackage(id);

    await this.stripe.archivePrice(pkg.stripePriceId);

    return this.packages.update(this.prisma, id, { active: false });
  }

  private async productIdForPlan(code: string, name: string): Promise<string> {
    const sibling = await this.plans.findWithProductByCode(this.prisma, code);
    if (sibling?.stripeProductId) return sibling.stripeProductId;

    const product = await this.stripe.createProduct({ code, name });

    return product.id;
  }

  private async productIdForPackage(code: string, name: string): Promise<string> {
    const existing = await this.packages.listAll(this.prisma);
    const sibling = existing.find((pkg) => pkg.code === code && pkg.stripeProductId);
    if (sibling?.stripeProductId) return sibling.stripeProductId;

    const product = await this.stripe.createProduct({ code, name });

    return product.id;
  }

  private async requirePlan(id: string): Promise<Plan> {
    const plan = await this.plans.findById(this.prisma, id);
    if (!plan) throw new NotFoundError('The plan does not exist', { planId: id });

    return plan;
  }

  private async requirePackage(id: string): Promise<AddonPackage> {
    const pkg = await this.packages.findById(this.prisma, id);
    if (!pkg) throw new NotFoundError('The add-on package does not exist', { packageId: id });

    return pkg;
  }
}
