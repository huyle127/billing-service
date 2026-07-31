import { HttpStatus, Injectable } from '@nestjs/common';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { BillingInterval } from '../generated/prisma/enums';
import type {
  AddonPackageModel,
  PlanModel,
  PricingOptionModel,
  ProductModel,
} from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';
import { CreditPolicy, creditPolicyOf } from './credit-policy';

export type PlanWithPricingOptions = PlanModel & {
  pricingOptions: PricingOptionModel[];
};

/**
 * Read access to the catalog. Everything downstream — what a period grants,
 * which Stripe Price a purchase maps to — resolves through here rather than
 * through constants, so the catalog stays the single place plan economics are
 * defined (`billing-catalog` → "Plan Credit Policy Is Read From The Catalog").
 */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async getProductByKey(key: string): Promise<ProductModel> {
    const product = await this.prisma.product.findUnique({ where: { key } });
    if (!product) {
      throw new BillingException(
        ErrorCode.NotFound,
        `No product is catalogued under the key "${key}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    return product;
  }

  /** The plans a user can hold for a product, each with its purchasable SKUs. */
  async listPlans(productId: string): Promise<PlanWithPricingOptions[]> {
    return this.prisma.plan.findMany({
      where: { productId },
      include: { pricingOptions: { orderBy: { unitAmount: 'asc' } } },
      orderBy: [{ isPaid: 'asc' }, { creditsPerPeriod: 'asc' }],
    });
  }

  async listPricingOptions(productId: string): Promise<PricingOptionModel[]> {
    return this.prisma.pricingOption.findMany({
      where: { plan: { productId } },
      orderBy: [{ planId: 'asc' }, { unitAmount: 'asc' }],
    });
  }

  async getPlanByKey(productId: string, planKey: string): Promise<PlanModel> {
    const plan = await this.prisma.plan.findUnique({
      where: { productId_key: { productId, key: planKey } },
    });
    if (!plan) {
      throw new BillingException(
        ErrorCode.InvalidPlanOrCycle,
        `No plan "${planKey}" is catalogued for this product.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return plan;
  }

  /**
   * The product's single free or single paid plan.
   *
   * The catalog offers exactly one of each per product, and the flows that need
   * one — Free provisioning, a Pro checkout — need *the* plan rather than a
   * caller-supplied key, so that neither has to name a plan in code. More than
   * one match is a seeding fault, not a client error.
   */
  async resolveSolePlan(
    productId: string,
    isPaid: boolean,
  ): Promise<PlanModel> {
    const plans = await this.prisma.plan.findMany({
      where: { productId, isPaid },
    });
    if (plans.length !== 1) {
      throw new BillingException(
        ErrorCode.InvalidPlanOrCycle,
        `Expected exactly one ${isPaid ? 'paid' : 'free'} plan for this ` +
          `product, found ${plans.length}.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return plans[0];
  }

  /**
   * Resolves the SKU for a plan and billing cycle. A cycle the catalog does not
   * offer is a client error, refused before any Stripe call is made.
   */
  async resolvePricingOption(
    planId: string,
    billingInterval: BillingInterval,
    billingIntervalCount = 1,
  ): Promise<PricingOptionModel> {
    const option = await this.prisma.pricingOption.findUnique({
      where: {
        planId_billingInterval_billingIntervalCount: {
          planId,
          billingInterval,
          billingIntervalCount,
        },
      },
    });
    if (!option) {
      throw new BillingException(
        ErrorCode.InvalidPlanOrCycle,
        `This plan is not offered on a ${billingIntervalCount}-${billingInterval.toLowerCase()} billing cycle.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return option;
  }

  /**
   * Add-on SKUs are catalogued per product and are deliberately not part of
   * {@link listPlans} — they are a one-time purchase, not something a user
   * subscribes to.
   */
  async listAddonPackages(productId: string): Promise<AddonPackageModel[]> {
    return this.prisma.addonPackage.findMany({
      where: { productId },
      orderBy: { creditAmount: 'asc' },
    });
  }

  /**
   * A single add-on SKU. The credit amount a purchase grants is read from here
   * rather than from the amount paid, so a price change never silently changes
   * what a purchase is worth in credit.
   */
  async getAddonPackageByKey(
    productId: string,
    key: string,
  ): Promise<AddonPackageModel> {
    const addonPackage = await this.prisma.addonPackage.findUnique({
      where: { productId_key: { productId, key } },
    });
    if (!addonPackage) {
      throw new BillingException(
        ErrorCode.NotFound,
        `No add-on "${key}" is catalogued for this product.`,
        HttpStatus.NOT_FOUND,
      );
    }
    return addonPackage;
  }

  creditPolicyFor(plan: PlanModel): CreditPolicy {
    return creditPolicyOf(plan);
  }
}
