import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CATALOG,
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { CatalogService } from '../../src/catalog/catalog.service';
import { BillingInterval } from '../../src/generated/prisma/enums';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { testDatabase } from './test-database';

/** Stand-in Stripe Price identifiers; the catalog only stores them. */
const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

describe('billing-catalog', () => {
  let moduleRef: TestingModule;
  let catalog: CatalogService;
  let productId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        CatalogModule,
      ],
    }).compile();
    await moduleRef.init();
    catalog = moduleRef.get(CatalogService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  // Runs after the global truncation in jest.setup.ts.
  beforeEach(async () => {
    const result = await seedCatalog(testDatabase.prisma, PRICE_IDS);
    productId = result.productId;
  });

  describe('Requirement: Product Is The Catalog Root', () => {
    it('Catalog is seeded for the current scope', async () => {
      const products = await testDatabase.prisma.product.findMany();
      expect(products).toHaveLength(1);
      expect(products[0].key).toBe('ai');

      const plans = await testDatabase.prisma.plan.findMany();
      const addons = await testDatabase.prisma.addonPackage.findMany();

      expect(plans.length).toBeGreaterThan(0);
      expect(addons.length).toBeGreaterThan(0);
      expect(plans.every((p) => p.productId === products[0].id)).toBe(true);
      expect(addons.every((a) => a.productId === products[0].id)).toBe(true);
    });

    it('No product-specific columns leak into shared tables', async () => {
      const columns = await testDatabase.prisma.$queryRaw<
        { table_name: string; column_name: string }[]
      >`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `;
      const productSpecific = columns.filter((c) =>
        /(^|_)ai(_|$)/i.test(c.column_name),
      );
      expect(productSpecific).toEqual([]);

      const enumLabels = await testDatabase.prisma.$queryRaw<
        { typname: string; enumlabel: string }[]
      >`
        SELECT t.typname, e.enumlabel
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
      `;
      expect(
        enumLabels.filter((l) => l.enumlabel.toLowerCase() === 'ai'),
      ).toEqual([]);

      // Product is identified by reference wherever it is needed. Asserted as
      // "every product_id is a real foreign key to products" rather than as a
      // fixed list of tables, so it keeps holding as later phases add
      // product-scoped models.
      const referencing = columns
        .filter((c) => c.column_name === 'product_id')
        .map((c) => c.table_name);
      expect(referencing).toEqual(expect.arrayContaining(['plans']));

      const foreignKeys = await testDatabase.prisma.$queryRaw<
        { table_name: string }[]
      >`
        SELECT tc.table_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND kcu.column_name = 'product_id'
          AND ccu.table_name = 'products'
      `;
      expect(foreignKeys.map((f) => f.table_name).sort()).toEqual(
        [...referencing].sort(),
      );
    });
  });

  describe('Requirement: Plan Belongs To Product', () => {
    it('Plans available for AI', async () => {
      const plans = await catalog.listPlans(productId);

      expect(plans.map((p) => p.key)).toEqual(['free', 'pro']);
    });

    it('Plan cannot exist without a product', async () => {
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO plans
             (key, name, is_paid, credits_per_period, credit_period_interval, updated_at)
           VALUES ('orphan', 'Orphan', false, 10, 'MONTH', now())`,
        ),
      ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
    });
  });

  describe('Requirement: PricingOption Maps One-To-One To A Stripe Price', () => {
    it('Pro offers both billing cycles', async () => {
      const pro = await catalog.getPlanByKey(productId, 'pro');

      const monthly = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.MONTH,
      );
      const annual = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.YEAR,
      );

      expect(monthly.stripePriceId).not.toBe(annual.stripePriceId);
    });

    it('Two pricing options cannot share a Stripe price', async () => {
      const pro = await catalog.getPlanByKey(productId, 'pro');
      const monthly = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.MONTH,
      );
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO pricing_options
             (plan_id, billing_interval, billing_interval_count, unit_amount, currency, stripe_price_id, updated_at)
           VALUES ($1, 'MONTH', 3, 500, 'usd', $2, now())`,
          [pro.id, monthly.stripePriceId],
        ),
      ).rejects.toMatchObject({ code: '23505' }); // unique_violation
    });

    it('Free is purchasable at zero cost', async () => {
      const free = await catalog.getPlanByKey(productId, 'free');

      const option = await catalog.resolvePricingOption(
        free.id,
        BillingInterval.MONTH,
      );

      expect(option.unitAmount).toBe(0);
      expect(option.billingInterval).toBe(BillingInterval.MONTH);
      expect(option.billingIntervalCount).toBe(1);
    });
  });

  describe('Requirement: Plan Credit Policy Is Read From The Catalog', () => {
    it('Grant amount comes from the plan', async () => {
      // An amount no constant in the codebase could plausibly hold, so a
      // hard-coded 50 or 100 could not produce this result. Phase 3 asserts the
      // resulting grant row; here the assertion is that the amount an
      // allocation would use is the one stored on the Plan.
      const plan = await testDatabase.prisma.plan.update({
        where: { productId_key: { productId, key: 'pro' } },
        data: { creditsPerPeriod: 37 },
      });

      expect(catalog.creditPolicyFor(plan).creditsPerPeriod).toBe(37);
    });

    it('Free plan credit amount', async () => {
      const free = await catalog.getPlanByKey(productId, 'free');

      expect(catalog.creditPolicyFor(free)).toEqual({
        creditsPerPeriod: 50,
        interval: BillingInterval.MONTH,
        intervalCount: 1,
      });
    });

    it('Pro plan credit amount', async () => {
      const pro = await catalog.getPlanByKey(productId, 'pro');

      expect(catalog.creditPolicyFor(pro)).toEqual({
        creditsPerPeriod: 100,
        interval: BillingInterval.MONTH,
        intervalCount: 1,
      });
    });

    it('Amounts are configuration, not code', async () => {
      await testDatabase.prisma.plan.update({
        where: { productId_key: { productId, key: 'pro' } },
        data: { creditsPerPeriod: 250 },
      });

      const pro = await catalog.getPlanByKey(productId, 'pro');

      expect(catalog.creditPolicyFor(pro).creditsPerPeriod).toBe(250);
    });
  });

  describe('Requirement: Credit Period Is Independent Of Billing Period', () => {
    it('Pro Annual bills yearly but resets monthly', async () => {
      const pro = await catalog.getPlanByKey(productId, 'pro');

      const annual = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.YEAR,
      );
      const policy = catalog.creditPolicyFor(pro);

      expect(annual.billingInterval).toBe(BillingInterval.YEAR);
      expect(policy.interval).toBe(BillingInterval.MONTH);
      expect(policy.creditsPerPeriod).toBe(100);
      expect(policy.creditsPerPeriod).not.toBe(1200);
    });

    it('Pro Monthly has coinciding periods', async () => {
      const pro = await catalog.getPlanByKey(productId, 'pro');

      const monthly = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.MONTH,
      );

      expect(monthly.billingInterval).toBe(BillingInterval.MONTH);
      expect(catalog.creditPolicyFor(pro).interval).toBe(BillingInterval.MONTH);
    });

    it('Credit period is not inferred from the billing cycle', async () => {
      const pro = await catalog.getPlanByKey(productId, 'pro');

      // Same plan, two billing cycles, one credit policy — the policy is read
      // from the Plan and never derived from the PricingOption.
      const policy = catalog.creditPolicyFor(pro);
      const monthly = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.MONTH,
      );
      const annual = await catalog.resolvePricingOption(
        pro.id,
        BillingInterval.YEAR,
      );

      expect(monthly.billingInterval).not.toBe(annual.billingInterval);
      expect(policy.interval).toBe(BillingInterval.MONTH);
      expect(policy.intervalCount).toBe(1);
    });
  });

  describe('Requirement: Add-On SKUs Are Catalogued Per Product', () => {
    it('Add-on SKU is not a subscription option', async () => {
      const addons = await catalog.listAddonPackages(productId);
      const plans = await catalog.listPlans(productId);
      const subscribablePriceIds = plans.flatMap((p) =>
        p.pricingOptions.map((o) => o.stripePriceId),
      );

      expect(addons.length).toBe(CATALOG.addonPackages.length);
      for (const addon of addons) {
        expect(subscribablePriceIds).not.toContain(addon.stripePriceId);
      }

      // Structurally non-recurring: an add-on SKU has no billing interval to
      // recur on in the first place.
      const columns = await testDatabase.prisma.$queryRaw<
        { column_name: string }[]
      >`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'addon_packages'
      `;
      expect(columns.map((c) => c.column_name)).not.toContain(
        'billing_interval',
      );
    });
  });
});
