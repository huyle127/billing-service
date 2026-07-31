import { BillingInterval } from '../generated/prisma/enums';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * The catalog's own configuration: what plans exist, what a credit period
 * grants, and what each SKU costs. Stripe Price identifiers are *not* here —
 * a fresh Stripe test account produces different ones, so they are supplied by
 * the caller against the `priceRef` names below.
 *
 * The amounts here must match the Stripe objects created per
 * `docs/stripe-setup.md`; seeding and Stripe setup are one procedure, not two.
 */

export const CATALOG_CURRENCY = 'usd';

export const CATALOG = {
  product: { key: 'ai', name: 'AI' },

  plans: [
    {
      key: 'free',
      name: 'Free',
      isPaid: false,
      creditsPerPeriod: 50,
      creditPeriodInterval: BillingInterval.MONTH,
      creditPeriodIntervalCount: 1,
    },
    {
      key: 'pro',
      name: 'Pro',
      isPaid: true,
      creditsPerPeriod: 100,
      creditPeriodInterval: BillingInterval.MONTH,
      creditPeriodIntervalCount: 1,
    },
  ],

  // The credit period above is monthly for both plans and is independent of
  // these billing intervals — Pro Annual bills yearly and still resets monthly.
  pricingOptions: [
    {
      planKey: 'free',
      billingInterval: BillingInterval.MONTH,
      unitAmount: 0,
      priceRef: 'STRIPE_PRICE_AI_FREE_MONTHLY',
    },
    {
      planKey: 'pro',
      billingInterval: BillingInterval.MONTH,
      unitAmount: 2000,
      priceRef: 'STRIPE_PRICE_AI_PRO_MONTHLY',
    },
    {
      planKey: 'pro',
      billingInterval: BillingInterval.YEAR,
      unitAmount: 20000,
      priceRef: 'STRIPE_PRICE_AI_PRO_ANNUAL',
    },
  ],

  addonPackages: [
    {
      key: 'credits-100',
      name: '100 AI credits',
      creditAmount: 100,
      unitAmount: 1000,
      priceRef: 'STRIPE_PRICE_AI_ADDON_100',
    },
    {
      key: 'credits-500',
      name: '500 AI credits',
      creditAmount: 500,
      unitAmount: 4000,
      priceRef: 'STRIPE_PRICE_AI_ADDON_500',
    },
  ],
} as const;

/** Every `priceRef` the catalog expects a Stripe Price identifier for. */
export const CATALOG_PRICE_REFS: string[] = [
  ...CATALOG.pricingOptions.map((o) => o.priceRef),
  ...CATALOG.addonPackages.map((a) => a.priceRef),
];

export type CatalogPriceIds = Record<string, string>;

export interface SeedCatalogResult {
  productId: string;
  planIds: Map<string, string>;
}

function priceIdFor(priceIds: CatalogPriceIds, ref: string): string {
  const value = priceIds[ref];
  if (!value) {
    throw new Error(
      `${ref} is not set. Create the Stripe prices described in ` +
        `docs/stripe-setup.md and put their identifiers in .env.`,
    );
  }
  return value;
}

/**
 * Writes the catalog. Every write is an upsert on a natural key, so re-running
 * against an already-seeded database changes nothing.
 */
export async function seedCatalog(
  prisma: PrismaClient,
  priceIds: CatalogPriceIds,
): Promise<SeedCatalogResult> {
  const product = await prisma.product.upsert({
    where: { key: CATALOG.product.key },
    create: { key: CATALOG.product.key, name: CATALOG.product.name },
    update: { name: CATALOG.product.name },
  });

  const planIds = new Map<string, string>();
  for (const plan of CATALOG.plans) {
    const policy = {
      name: plan.name,
      isPaid: plan.isPaid,
      creditsPerPeriod: plan.creditsPerPeriod,
      creditPeriodInterval: plan.creditPeriodInterval,
      creditPeriodIntervalCount: plan.creditPeriodIntervalCount,
    };
    const row = await prisma.plan.upsert({
      where: { productId_key: { productId: product.id, key: plan.key } },
      create: { ...policy, key: plan.key, productId: product.id },
      update: policy,
    });
    planIds.set(plan.key, row.id);
  }

  for (const option of CATALOG.pricingOptions) {
    const identity = {
      planId: planIds.get(option.planKey)!,
      billingInterval: option.billingInterval,
      billingIntervalCount: 1,
    };
    const pricing = {
      unitAmount: option.unitAmount,
      currency: CATALOG_CURRENCY,
      stripePriceId: priceIdFor(priceIds, option.priceRef),
    };

    await prisma.pricingOption.upsert({
      where: { planId_billingInterval_billingIntervalCount: identity },
      create: { ...identity, ...pricing },
      update: pricing,
    });
  }

  for (const addon of CATALOG.addonPackages) {
    const fields = {
      name: addon.name,
      creditAmount: addon.creditAmount,
      unitAmount: addon.unitAmount,
      currency: CATALOG_CURRENCY,
      stripePriceId: priceIdFor(priceIds, addon.priceRef),
    };

    await prisma.addonPackage.upsert({
      where: { productId_key: { productId: product.id, key: addon.key } },
      create: { ...fields, key: addon.key, productId: product.id },
      update: fields,
    });
  }

  return { productId: product.id, planIds };
}
