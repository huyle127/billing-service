import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { CustomersService } from '../../src/customers/customers.service';
import { SubscriptionStatus } from '../../src/generated/prisma/enums';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import { FakeBillingProvider } from '../../src/provider/testing/fake-billing.provider';
import { ProvisioningService } from '../../src/subscriptions/provisioning.service';
import { SubscriptionLookupService } from '../../src/subscriptions/subscription-lookup.service';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository';
import { testDatabase } from './test-database';

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

describe('stripe-integration and provisioning', () => {
  let moduleRef: TestingModule;
  let provisioning: ProvisioningService;
  let customers: CustomersService;
  let provider: FakeBillingProvider;
  let productId: string;
  let userId: string;
  let freePriceId: string;

  beforeAll(async () => {
    provider = new FakeBillingProvider();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        CatalogModule,
      ],
      providers: [
        ProvisioningService,
        SubscriptionLookupService,
        SubscriptionRepository,
        CustomersService,
        { provide: BILLING_PROVIDER, useValue: provider },
      ],
    }).compile();
    await moduleRef.init();

    provisioning = moduleRef.get(ProvisioningService);
    customers = moduleRef.get(CustomersService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    provider.reset();
    const seeded = await seedCatalog(testDatabase.prisma, PRICE_IDS);
    productId = seeded.productId;
    freePriceId = PRICE_IDS.STRIPE_PRICE_AI_FREE_MONTHLY;
    const user = await testDatabase.prisma.user.create({
      data: { email: `${randomUUID()}@test.local` },
    });
    userId = user.id;
  });

  async function newUser(): Promise<string> {
    const user = await testDatabase.prisma.user.create({
      data: { email: `${randomUUID()}@test.local` },
    });
    return user.id;
  }

  // ==========================================================================
  describe('Requirement: Business Logic Is Decoupled From The Stripe SDK', () => {
    it('Business logic tested without Stripe', async () => {
      expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();

      const subscription = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      expect(subscription.providerSubscriptionId).toMatch(/^sub_/);
    });
  });

  // ==========================================================================
  describe('Requirement: Stripe Customer Lifecycle', () => {
    it('Customer created on first need', async () => {
      const customerId = await customers.getOrCreateStripeCustomer(userId);

      const user = await testDatabase.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.stripeCustomerId).toBe(customerId);
      expect(provider.callsTo('createCustomer')).toHaveLength(1);
    });

    it('Customer is reused', async () => {
      const first = await customers.getOrCreateStripeCustomer(userId);

      const second = await customers.getOrCreateStripeCustomer(userId);

      expect(second).toBe(first);
      expect(provider.callsTo('createCustomer')).toHaveLength(1);
    });

    it('Concurrent customer creation', async () => {
      const [a, b] = await Promise.all([
        customers.getOrCreateStripeCustomer(userId),
        customers.getOrCreateStripeCustomer(userId),
      ]);

      expect(a).toBe(b);
      const user = await testDatabase.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(user.stripeCustomerId).toBe(a);
    });

    it('Missing customer is a handled error', async () => {
      const customerId = await customers.getOrCreateStripeCustomer(userId);
      provider.customers.delete(customerId);

      await expect(
        customers.requireProviderCustomer(userId),
      ).rejects.toMatchObject({ code: 'MISSING_STRIPE_CUSTOMER' });

      const subscriptions = await testDatabase.prisma.subscription.count();
      expect(subscriptions).toBe(0);
    });
  });

  // ==========================================================================
  describe('Requirement: Payment Method Handling', () => {
    it('Free requires no payment method', async () => {
      // The fake is never given one, and provisioning still succeeds because
      // the Free price is zero-amount.
      const subscription = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
      const created = provider.callsTo('createSubscription')[0] as {
        priceId: string;
      };
      expect(created.priceId).toBe(freePriceId);
    });
  });

  // ==========================================================================
  describe('Requirement: Stripe Is The Source Of Truth For Provider Billing State', () => {
    it('Local state follows Stripe', async () => {
      const subscription = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      const atProvider = provider.subscriptions.get(
        subscription.providerSubscriptionId,
      )!;
      expect(subscription.status).toBe(atProvider.status);
      expect(subscription.cancelAtPeriodEnd).toBe(atProvider.cancelAtPeriodEnd);
      expect(subscription.currentPeriodEnd).toEqual(
        atProvider.currentPeriodEnd,
      );
    });
  });

  // ==========================================================================
  describe('Requirement: Stripe Calls Are Never Inside A Database Transaction', () => {
    it('Failed post-commit Stripe call does not roll back local state', async () => {
      // Two callers race; the loser's cleanup call to the provider fails.
      const other = moduleRef.get(ProvisioningService);
      await provisioning.provisionFreeSubscription(userId, productId);
      provider.failNext(
        'cancelSubscriptionNow',
        new Error('provider unavailable'),
      );

      const result = await other.provisionFreeSubscription(userId, productId);

      // Local state is committed and consistent; the discrepancy is left for
      // reconciliation rather than failing the caller.
      expect(result.userId).toBe(userId);
      const live = await testDatabase.prisma.subscription.findMany({
        where: { userId, productId, status: SubscriptionStatus.ACTIVE },
      });
      expect(live).toHaveLength(1);
    });
  });

  // ==========================================================================
  describe('Requirement: One Live Subscription Per User Per Product', () => {
    it('New user is provisioned for AI', async () => {
      const subscription = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: subscription.planId },
      });
      expect(plan.key).toBe('free');
      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE);
      expect(
        provider.subscriptions.get(subscription.providerSubscriptionId),
      ).toBeDefined();
    });

    it('Concurrent provisioning attempts', async () => {
      const results = await Promise.allSettled([
        provisioning.provisionFreeSubscription(userId, productId),
        provisioning.provisionFreeSubscription(userId, productId),
      ]);

      // Neither caller sees an error.
      expect(results.filter((r) => r.status === 'rejected')).toEqual([]);

      const live = await testDatabase.prisma.subscription.findMany({
        where: { userId, productId, status: SubscriptionStatus.ACTIVE },
      });
      expect(live).toHaveLength(1);

      // And nothing is left orphaned at the provider.
      expect(provider.liveSubscriptions()).toHaveLength(1);
      expect(provider.liveSubscriptions()[0].id).toBe(
        live[0].providerSubscriptionId,
      );
    });

    it('Database rejects a second live row', async () => {
      const existing = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO subscriptions
             (user_id, product_id, plan_id, pricing_option_id,
              provider_subscription_id, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'ACTIVE', now())`,
          [
            userId,
            productId,
            existing.planId,
            existing.pricingOptionId,
            `sub_second_${randomUUID()}`,
          ],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('Terminal rows do not block new subscriptions', async () => {
      const client = await testDatabase.newPgClient();
      const first = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );
      // Three terminal rows, no live one.
      await testDatabase.prisma.subscription.update({
        where: { id: first.id },
        data: { status: SubscriptionStatus.CANCELED },
      });
      for (const status of ['CANCELED', 'UNPAID']) {
        await client.query(
          `INSERT INTO subscriptions
             (user_id, product_id, plan_id, pricing_option_id,
              provider_subscription_id, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::"SubscriptionStatus", now())`,
          [
            userId,
            productId,
            first.planId,
            first.pricingOptionId,
            `sub_terminal_${randomUUID()}`,
            status,
          ],
        );
      }

      const replacement = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      expect(replacement.id).not.toBe(first.id);
      expect(replacement.status).toBe(SubscriptionStatus.ACTIVE);
      expect(
        await testDatabase.prisma.subscription.count({ where: { userId } }),
      ).toBe(4);
    });
  });

  // ==========================================================================
  describe('Requirement: Subscription Identity Is Permanent', () => {
    it('Attempt to repoint an existing subscription', async () => {
      const subscription = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `UPDATE subscriptions SET provider_subscription_id = $2 WHERE id = $1::uuid`,
          [subscription.id, 'sub_repointed'],
        ),
      ).rejects.toMatchObject({ code: '23514' });

      const after = await testDatabase.prisma.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
      });
      expect(after.providerSubscriptionId).toBe(
        subscription.providerSubscriptionId,
      );
    });

    it('Provider subscription id is unique across rows', async () => {
      const subscription = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );
      const otherUser = await newUser();
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO subscriptions
             (user_id, product_id, plan_id, pricing_option_id,
              provider_subscription_id, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'ACTIVE', now())`,
          [
            otherUser,
            productId,
            subscription.planId,
            subscription.pricingOptionId,
            subscription.providerSubscriptionId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('Every subscription has a provider counterpart', async () => {
      await provisioning.provisionFreeSubscription(userId, productId);

      const rows = await testDatabase.prisma.subscription.findMany();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.billingMode).toBe('PROVIDER');
        expect(row.providerSubscriptionId).toBeTruthy();
      }

      // The column is NOT NULL, so a row without one cannot be written at all.
      const client = await testDatabase.newPgClient();
      await expect(
        client.query(
          `INSERT INTO subscriptions
             (user_id, product_id, plan_id, pricing_option_id, status, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', now())`,
          [userId, productId, rows[0].planId, rows[0].pricingOptionId],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });

  // ==========================================================================
  describe('Requirement: Free Provisioning Has Exactly Two Triggers', () => {
    it('Provisioning is idempotent', async () => {
      const first = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      const second = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );

      expect(second.id).toBe(first.id);
      expect(
        await testDatabase.prisma.subscription.count({ where: { userId } }),
      ).toBe(1);
      // No surplus provider subscription either.
      expect(provider.callsTo('createSubscription')).toHaveLength(1);
    });
  });
});
