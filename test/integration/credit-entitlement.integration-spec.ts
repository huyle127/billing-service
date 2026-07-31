import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { CatalogService } from '../../src/catalog/catalog.service';
import { CreditsModule } from '../../src/credits/credits.module';
import { CreditRepository } from '../../src/credits/credit.repository';
import { CreditsService } from '../../src/credits/credits.service';
import { EntitlementState } from '../../src/credits/spendability';
import {
  CreditGrantSource,
  CreditTransactionType,
} from '../../src/generated/prisma/enums';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { testDatabase } from './test-database';

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

const PRO_ACTIVE: EntitlementState = {
  kind: 'live',
  isPaidPlan: true,
  isPastDue: false,
};
const PRO_PAST_DUE: EntitlementState = {
  kind: 'live',
  isPaidPlan: true,
  isPastDue: true,
};
const FREE_ACTIVE: EntitlementState = {
  kind: 'live',
  isPaidPlan: false,
  isPastDue: false,
};

const JAN = new Date('2026-01-01T00:00:00.000Z');
const FEB = new Date('2026-02-01T00:00:00.000Z');
const MAR = new Date('2026-03-01T00:00:00.000Z');

function monthsAfter(start: Date, months: number): Date {
  const d = new Date(start);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

describe('credit-entitlement', () => {
  let moduleRef: TestingModule;
  let credits: CreditsService;
  let catalog: CatalogService;
  let productId: string;
  let userId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        CatalogModule,
        CreditsModule,
      ],
    }).compile();
    await moduleRef.init();
    credits = moduleRef.get(CreditsService);
    catalog = moduleRef.get(CatalogService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    const seeded = await seedCatalog(testDatabase.prisma, PRICE_IDS);
    productId = seeded.productId;
    const user = await testDatabase.prisma.user.create({
      data: { email: `${randomUUID()}@test.local` },
    });
    userId = user.id;
  });

  /** A second service on its own connection, for genuine interleaving. */
  function otherConnection(): CreditsService {
    const client = testDatabase.newPrismaClient() as unknown as PrismaService;
    // The repository takes the same connection, or the two halves of the
    // service would talk to different ones and the interleaving would be fake.
    return new CreditsService(client, new CreditRepository(client));
  }

  async function planCredits(planKey: string): Promise<number> {
    const plan = await catalog.getPlanByKey(productId, planKey);
    return catalog.creditPolicyFor(plan).creditsPerPeriod;
  }

  async function createGrant(input: {
    source?: CreditGrantSource;
    amount: number;
    priority: number;
    expiresAt?: Date | null;
    subscriptionId?: string | null;
    addonPurchaseId?: string | null;
    userId?: string;
    productId?: string;
  }) {
    return testDatabase.prisma.creditGrant.create({
      data: {
        userId: input.userId ?? userId,
        productId: input.productId ?? productId,
        source: input.source ?? CreditGrantSource.SUBSCRIPTION,
        amountInitial: input.amount,
        amountRemaining: input.amount,
        priority: input.priority,
        expiresAt: input.expiresAt ?? null,
        subscriptionId: input.subscriptionId ?? randomUUID(),
        addonPurchaseId: input.addonPurchaseId ?? null,
      },
    });
  }

  async function totalRemaining(forUser = userId): Promise<number> {
    const result = await testDatabase.prisma.creditGrant.aggregate({
      where: { userId: forUser, productId },
      _sum: { amountRemaining: true },
    });
    return result._sum.amountRemaining ?? 0;
  }

  // ==========================================================================
  describe('Requirement: Credit Is Product Scoped', () => {
    it('Grant always names its product', async () => {
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO credit_grants
             (user_id, source, amount_initial, amount_remaining, priority, updated_at)
           VALUES ($1::uuid, 'SUBSCRIPTION', 10, 10, 100, now())`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });

    it('Credits do not cross products', async () => {
      const storage = await testDatabase.prisma.product.create({
        data: { key: 'storage', name: 'Storage' },
      });
      await createGrant({ amount: 100, priority: 100 });

      await expect(
        credits.consume({
          userId,
          productId: storage.id,
          requestId: randomUUID(),
          amount: 10,
          entitlement: PRO_ACTIVE,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

      expect(await totalRemaining()).toBe(100);
    });
  });

  // ==========================================================================
  describe('Requirement: Every Credit Movement Is Ledgered', () => {
    it('Consumption spanning two grants', async () => {
      await createGrant({ amount: 30, priority: 100 });
      await createGrant({ amount: 50, priority: 200 });

      const result = await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 60,
        entitlement: PRO_ACTIVE,
      });

      const rows = await testDatabase.prisma.creditTransaction.findMany({
        where: { operationId: result.operationId },
      });
      expect(rows).toHaveLength(2);
      expect(rows.reduce((sum, r) => sum - r.amount, 0)).toBe(60);
    });

    it('Ledger records the balance impact', async () => {
      await createGrant({ amount: 100, priority: 100 });

      const result = await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 40,
        entitlement: PRO_ACTIVE,
        relatedEvent: { type: 'stripe.invoice', id: 'in_test_1' },
      });

      const [row] = await testDatabase.prisma.creditTransaction.findMany({
        where: { operationId: result.operationId },
      });
      expect(row.type).toBe(CreditTransactionType.CONSUMPTION);
      expect(row.amount).toBe(-40);
      expect(row.grantAmountRemainingAfter).toBe(60);
      expect(row.relatedEventType).toBe('stripe.invoice');
      expect(row.relatedEventId).toBe('in_test_1');
      expect(row.createdAt).toBeInstanceOf(Date);
    });

    it('Transaction cannot reference two grants', async () => {
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO credit_transactions
             (operation_id, type, amount, grant_amount_remaining_after)
           VALUES (gen_random_uuid(), 'CONSUMPTION', -1, 0)`,
        ),
      ).rejects.toMatchObject({ code: '23502' });
    });
  });

  // ==========================================================================
  describe('Requirement: Credits Are Granted Once Per Credit Period', () => {
    it("Renewal grants a credit period's credits", async () => {
      const subscriptionId = randomUUID();
      const amount = await planCredits('pro');

      const { grant, created } = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount,
      });

      expect(created).toBe(true);
      expect(grant.amountInitial).toBe(amount);
      expect(grant.subscriptionId).toBe(subscriptionId);
      expect(grant.source).toBe(CreditGrantSource.SUBSCRIPTION);
    });

    it('Both allocation paths fall due for the same credit period', async () => {
      const subscriptionId = randomUUID();
      const invoicePath = credits;
      const resetPath = otherConnection();
      const input = {
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
      };

      const results = await Promise.all([
        invoicePath.allocateSubscriptionCredits(input),
        resetPath.allocateSubscriptionCredits(input),
      ]);

      // Both complete without error; exactly one created the grant.
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const grants = await testDatabase.prisma.creditGrant.findMany({
        where: { subscriptionId },
      });
      expect(grants).toHaveLength(1);
    });

    it('Database rejects a second grant for the same credit period', async () => {
      const subscriptionId = randomUUID();
      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
      });
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO credit_grants
             (user_id, product_id, source, amount_initial, amount_remaining,
              priority, subscription_id, credit_period_start, updated_at)
           VALUES ($1::uuid, $2::uuid, 'SUBSCRIPTION', 100, 100, 100,
                   $3::uuid, $4::timestamp, now())`,
          [userId, productId, subscriptionId, JAN.toISOString()],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('Duplicate invoice event', async () => {
      const subscriptionId = randomUUID();
      const input = {
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
        relatedEvent: { type: 'stripe.event', id: 'evt_duplicate' },
      };

      const first = await credits.allocateSubscriptionCredits(input);
      const second = await credits.allocateSubscriptionCredits(input);

      expect(second.created).toBe(false);
      expect(second.grant.id).toBe(first.grant.id);
      expect(
        await testDatabase.prisma.creditGrant.count({
          where: { subscriptionId },
        }),
      ).toBe(1);
      expect(
        await testDatabase.prisma.creditTransaction.count({
          where: { type: CreditTransactionType.ALLOCATION },
        }),
      ).toBe(1);
    });

    it('Two instances receive the same event at once', async () => {
      const subscriptionId = randomUUID();
      const instanceA = credits;
      const instanceB = otherConnection();
      const input = {
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
      };

      await Promise.all([
        instanceA.allocateSubscriptionCredits(input),
        instanceB.allocateSubscriptionCredits(input),
      ]);

      expect(
        await testDatabase.prisma.creditGrant.count({
          where: { subscriptionId },
        }),
      ).toBe(1);
    });
  });

  // ==========================================================================
  describe('Requirement: Free Plan Credit Allocation', () => {
    it("Free subscription's first month", async () => {
      const subscriptionId = randomUUID();

      const { grant } = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: await planCredits('free'),
      });

      expect(grant.amountRemaining).toBe(50);
      expect(grant.source).toBe(CreditGrantSource.SUBSCRIPTION);
    });

    it('Free subscription renews monthly', async () => {
      const subscriptionId = randomUUID();
      const amount = await planCredits('free');
      const first = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount,
      });

      const second = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount,
      });

      const priorPeriod =
        await testDatabase.prisma.creditGrant.findUniqueOrThrow({
          where: { id: first.grant.id },
        });
      expect(priorPeriod.amountRemaining).toBe(0);
      expect(second.grant.amountRemaining).toBe(50);
    });

    it('Free reset uses the same mechanism as paid', async () => {
      const freeSubscription = randomUUID();
      const proSubscription = randomUUID();

      const free = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: freeSubscription,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: await planCredits('free'),
      });
      const pro = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: proSubscription,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: await planCredits('pro'),
      });

      // Same grant shape and same ledger shape; only the amount differs, and it
      // came from each plan's own credit policy.
      expect(free.grant.source).toBe(pro.grant.source);
      expect(free.grant.priority).toBe(pro.grant.priority);
      expect(free.grant.amountInitial).toBe(50);
      expect(pro.grant.amountInitial).toBe(100);

      const ledgerTypes = await testDatabase.prisma.creditTransaction.findMany({
        where: { creditGrantId: { in: [free.grant.id, pro.grant.id] } },
        select: { type: true },
      });
      expect(ledgerTypes.map((t) => t.type)).toEqual([
        CreditTransactionType.ALLOCATION,
        CreditTransactionType.ALLOCATION,
      ]);
    });
  });

  // ==========================================================================
  describe('Requirement: Pro Plan Credit Allocation', () => {
    it('Pro Monthly grants each month at its invoice', async () => {
      const subscriptionId = randomUUID();
      const amount = await planCredits('pro');
      const january = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount,
      });

      const february = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount,
      });

      expect(february.grant.amountRemaining).toBe(100);
      const prior = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: january.grant.id },
      });
      expect(prior.amountRemaining).toBe(0);
    });

    it('Pro Annual does not front-load a year of credits', async () => {
      const subscriptionId = randomUUID();

      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: await planCredits('pro'),
      });

      const grants = await testDatabase.prisma.creditGrant.findMany({
        where: { subscriptionId },
      });
      expect(grants).toHaveLength(1);
      expect(grants[0].amountInitial).toBe(100);
      expect(grants.some((g) => g.amountInitial === 1200)).toBe(false);
      expect(
        grants.filter((g) => g.creditPeriodStart?.getTime() !== JAN.getTime()),
      ).toEqual([]);
    });

    it('Pro Annual resets monthly across the paid year', async () => {
      const subscriptionId = randomUUID();
      const amount = await planCredits('pro');

      for (let month = 0; month < 12; month++) {
        await credits.allocateSubscriptionCredits({
          userId,
          productId,
          subscriptionId,
          creditPeriodStart: monthsAfter(JAN, month),
          creditPeriodEnd: monthsAfter(JAN, month + 1),
          amount,
        });
      }

      const grants = await testDatabase.prisma.creditGrant.findMany({
        where: { subscriptionId },
        orderBy: { creditPeriodStart: 'asc' },
      });
      expect(grants).toHaveLength(12);
      expect(grants.every((g) => g.amountInitial === 100)).toBe(true);

      const starts = grants.map((g) => g.creditPeriodStart!.toISOString());
      expect(new Set(starts).size).toBe(12);
      for (let month = 0; month < 12; month++) {
        expect(starts[month]).toBe(monthsAfter(JAN, month).toISOString());
      }
    });

    it('Unspent Pro credits do not roll over between credit periods', async () => {
      const subscriptionId = randomUUID();
      const amount = await planCredits('pro');
      const january = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount,
      });
      await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 40,
        entitlement: PRO_ACTIVE,
      });

      const february = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount,
      });

      expect(february.grant.amountInitial).toBe(100);
      expect(february.grant.amountInitial).not.toBe(160);
      const prior = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: january.grant.id },
      });
      expect(prior.amountRemaining).toBe(0);
    });
  });

  // ==========================================================================
  describe('Requirement: Credit Consumption Order Is Deterministic', () => {
    it('Multiple grants available', async () => {
      const soon = new Date(Date.now() + 60 * 60 * 1000);
      const later = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const lowPriority = await createGrant({
        amount: 10,
        priority: 10,
        expiresAt: later,
      });
      const samePriorityEarlierExpiry = await createGrant({
        amount: 10,
        priority: 10,
        expiresAt: soon,
      });
      const neverExpires = await createGrant({ amount: 10, priority: 20 });

      const result = await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 25,
        entitlement: PRO_ACTIVE,
      });

      expect(result.entries.map((e) => e.grantId)).toEqual([
        samePriorityEarlierExpiry.id,
        lowPriority.id,
        neverExpires.id,
      ]);
      expect(result.entries.reduce((sum, e) => sum + e.amount, 0)).toBe(25);
    });

    it('Exhausted grants are skipped', async () => {
      const exhausted = await testDatabase.prisma.creditGrant.create({
        data: {
          userId,
          productId,
          source: CreditGrantSource.SUBSCRIPTION,
          amountInitial: 10,
          amountRemaining: 0,
          priority: 1,
          subscriptionId: randomUUID(),
        },
      });
      const funded = await createGrant({ amount: 10, priority: 500 });

      const result = await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 5,
        entitlement: PRO_ACTIVE,
      });

      expect(result.entries.map((e) => e.grantId)).toEqual([funded.id]);
      expect(
        await testDatabase.prisma.creditTransaction.count({
          where: { creditGrantId: exhausted.id },
        }),
      ).toBe(0);
    });

    it('Consumption order is not hard-coded by source', async () => {
      // The add-on grant is given the lower priority, so it must drain first.
      // An implementation ordering "subscription before add-on" in code fails.
      const addonFirst = await createGrant({
        source: CreditGrantSource.ADDON,
        amount: 10,
        priority: 1,
        addonPurchaseId: randomUUID(),
        subscriptionId: null,
      });
      const subscriptionSecond = await createGrant({
        amount: 10,
        priority: 900,
      });

      const result = await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 15,
        entitlement: PRO_ACTIVE,
      });

      expect(result.entries.map((e) => e.grantId)).toEqual([
        addonFirst.id,
        subscriptionSecond.id,
      ]);
    });
  });

  // ==========================================================================
  describe('Requirement: Credit Balance Never Goes Negative', () => {
    it('Concurrent consumption cannot overdraw', async () => {
      await createGrant({ amount: 100, priority: 100 });
      const a = credits;
      const b = otherConnection();

      const results = await Promise.allSettled([
        a.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 80,
          entitlement: PRO_ACTIVE,
        }),
        b.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 80,
          entitlement: PRO_ACTIVE,
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await totalRemaining()).toBe(20);
    });

    it('Insufficient credit is refused', async () => {
      const grant = await createGrant({ amount: 10, priority: 100 });

      await expect(
        credits.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 50,
          entitlement: PRO_ACTIVE,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

      const after = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.amountRemaining).toBe(10);
      expect(
        await testDatabase.prisma.creditTransaction.count({
          where: { creditGrantId: grant.id },
        }),
      ).toBe(0);
    });

    it('Database rejects a negative remaining amount', async () => {
      const grant = await createGrant({ amount: 10, priority: 100 });
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `UPDATE credit_grants SET amount_remaining = -1 WHERE id = $1::uuid`,
          [grant.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('Locking order prevents deadlock', async () => {
      // Both consumptions touch the same three grants. They acquire locks in
      // the same order, so neither deadlocks and both complete.
      await createGrant({ amount: 100, priority: 10 });
      await createGrant({ amount: 100, priority: 20 });
      await createGrant({ amount: 100, priority: 30 });
      const a = credits;
      const b = otherConnection();

      const results = await Promise.allSettled([
        a.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 150,
          entitlement: PRO_ACTIVE,
        }),
        b.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 150,
          entitlement: PRO_ACTIVE,
        }),
      ]);

      const failures = results.filter((r) => r.status === 'rejected');
      expect(failures).toEqual([]);
      expect(await totalRemaining()).toBe(0);
    });
  });

  // ==========================================================================
  describe('Requirement: Consumption Idempotency Is Product Scoped', () => {
    it('Same request id reused across two products', async () => {
      const storage = await testDatabase.prisma.product.create({
        data: { key: 'storage', name: 'Storage' },
      });
      const requestId = randomUUID();
      await createGrant({ amount: 50, priority: 100 });
      await createGrant({
        amount: 50,
        priority: 100,
        productId: storage.id,
      });

      const first = await credits.consume({
        userId,
        productId,
        requestId,
        amount: 10,
        entitlement: PRO_ACTIVE,
      });
      const second = await credits.consume({
        userId,
        productId: storage.id,
        requestId,
        amount: 10,
        entitlement: PRO_ACTIVE,
      });

      expect(second.deduplicated).toBe(false);
      expect(second.operationId).not.toBe(first.operationId);
      expect(await totalRemaining()).toBe(40);
    });

    it('Replayed consumption is deduplicated', async () => {
      await createGrant({ amount: 50, priority: 100 });
      const requestId = randomUUID();
      const first = await credits.consume({
        userId,
        productId,
        requestId,
        amount: 20,
        entitlement: PRO_ACTIVE,
      });

      const replay = await credits.consume({
        userId,
        productId,
        requestId,
        amount: 20,
        entitlement: PRO_ACTIVE,
      });

      expect(replay.deduplicated).toBe(true);
      expect(replay.operationId).toBe(first.operationId);
      expect(replay.amount).toBe(20);
      expect(await totalRemaining()).toBe(30);
    });

    it('Duplicate key is rejected by the database', async () => {
      const grant = await createGrant({ amount: 10, priority: 100 });
      const client = await testDatabase.newPgClient();
      const key = `req:${userId}:${productId}:fixed:consume`;
      const insert = `INSERT INTO credit_transactions
          (credit_grant_id, operation_id, idempotency_key, type, amount,
           grant_amount_remaining_after)
        VALUES ($1::uuid, gen_random_uuid(), $2, 'CONSUMPTION', -1, 0)`;

      await client.query(insert, [grant.id, key]);

      await expect(client.query(insert, [grant.id, key])).rejects.toMatchObject(
        { code: '23505' },
      );
    });
  });

  // ==========================================================================
  describe('Requirement: Freeze Is Derived From Subscription State', () => {
    it('No stored freeze flag', async () => {
      const columns = await testDatabase.prisma.$queryRaw<
        { table_name: string; column_name: string }[]
      >`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('credit_grants', 'credit_transactions')
      `;

      expect(
        columns.filter((c) => /frozen|freeze/i.test(c.column_name)),
      ).toEqual([]);
    });

    it('Freeze status changes without touching credit rows', async () => {
      const grant = await createGrant({ amount: 100, priority: 100 });
      const before = grant.updatedAt;

      await expect(
        credits.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 10,
          entitlement: PRO_PAST_DUE,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

      const after = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.updatedAt).toEqual(before);
      expect(after.amountRemaining).toBe(100);
    });
  });

  // ==========================================================================
  describe('Requirement: Add-On Credits Freeze Rather Than Expire', () => {
    it('Dropping to free', async () => {
      const addon = await createGrant({
        source: CreditGrantSource.ADDON,
        amount: 200,
        priority: 200,
        addonPurchaseId: randomUUID(),
        subscriptionId: null,
      });

      await expect(
        credits.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 10,
          entitlement: FREE_ACTIVE,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

      const after = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: addon.id },
      });
      expect(after.amountRemaining).toBe(200);
      expect(after.expiresAt).toBeNull();
    });

    it('Resubscribing', async () => {
      const addon = await createGrant({
        source: CreditGrantSource.ADDON,
        amount: 200,
        priority: 200,
        addonPurchaseId: randomUUID(),
        subscriptionId: null,
      });

      const frozen = await credits.getBalance(userId, productId, FREE_ACTIVE);
      const restored = await credits.getBalance(userId, productId, PRO_ACTIVE);

      expect(frozen).toMatchObject({ spendable: 0, frozen: 200 });
      expect(restored).toMatchObject({ spendable: 200, frozen: 0 });

      const result = await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 200,
        entitlement: PRO_ACTIVE,
      });
      expect(result.entries.map((e) => e.grantId)).toEqual([addon.id]);
    });
  });

  // ==========================================================================
  describe('Requirement: Grace Period Freezes Consumption', () => {
    it('Consumption during grace period', async () => {
      const subscription = await createGrant({ amount: 100, priority: 100 });
      const addon = await createGrant({
        source: CreditGrantSource.ADDON,
        amount: 50,
        priority: 200,
        addonPurchaseId: randomUUID(),
        subscriptionId: null,
      });

      await expect(
        credits.consume({
          userId,
          productId,
          requestId: randomUUID(),
          amount: 1,
          entitlement: PRO_PAST_DUE,
        }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

      const rows = await testDatabase.prisma.creditGrant.findMany({
        where: { id: { in: [subscription.id, addon.id] } },
        orderBy: { priority: 'asc' },
      });
      expect(rows.map((r) => r.amountRemaining)).toEqual([100, 50]);
      expect(rows.every((r) => r.expiresAt === null)).toBe(true);
    });

    it('Restoration on successful retry', async () => {
      await createGrant({ amount: 100, priority: 100 });
      await createGrant({
        source: CreditGrantSource.ADDON,
        amount: 50,
        priority: 200,
        addonPurchaseId: randomUUID(),
        subscriptionId: null,
      });

      const duringGrace = await credits.getBalance(
        userId,
        productId,
        PRO_PAST_DUE,
      );
      const afterRecovery = await credits.getBalance(
        userId,
        productId,
        PRO_ACTIVE,
      );

      expect(duringGrace).toMatchObject({
        spendable: 0,
        frozen: 150,
        freezeReason: 'PAST_DUE',
      });
      expect(afterRecovery).toMatchObject({
        spendable: 150,
        frozen: 0,
        freezeReason: null,
      });
    });
  });

  // ==========================================================================
  describe('Requirement: Subscription Credits Expire With Their Credit Period', () => {
    it('Unspent credits expire at the end of their credit period', async () => {
      const subscriptionId = randomUUID();
      const january = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
      });

      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount: 100,
      });

      const prior = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: january.grant.id },
      });
      expect(prior.amountRemaining).toBe(0);

      const expiry = await testDatabase.prisma.creditTransaction.findFirst({
        where: {
          creditGrantId: january.grant.id,
          type: CreditTransactionType.EXPIRY,
        },
      });
      expect(expiry).not.toBeNull();
      expect(expiry!.amount).toBe(-100);
    });
  });

  // ==========================================================================
  describe('Requirement: Pro Credits Expire On The Transition To Free', () => {
    it('Pro credits expire when entitlement ends', async () => {
      const subscriptionId = randomUUID();
      const { grant } = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
      });

      await credits.expireSubscriptionGrants(subscriptionId, {
        type: 'stripe.event',
        id: 'evt_sub_deleted',
      });

      const after = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: grant.id },
      });
      expect(after.amountRemaining).toBe(0);

      const expiry = await testDatabase.prisma.creditTransaction.findFirst({
        where: {
          creditGrantId: grant.id,
          type: CreditTransactionType.EXPIRY,
        },
      });
      expect(expiry).not.toBeNull();
      expect(expiry!.relatedEventId).toBe('evt_sub_deleted');
    });

    it('Free credits are provisioned after the transition', async () => {
      const proSubscription = randomUUID();
      const freeSubscription = randomUUID();
      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: proSubscription,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: await planCredits('pro'),
      });
      await credits.expireSubscriptionGrants(proSubscription);

      // The new Free Subscription's first credit period goes through the same
      // allocation routine every other period uses.
      const { grant, created } = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: freeSubscription,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount: await planCredits('free'),
      });

      expect(created).toBe(true);
      expect(grant.amountRemaining).toBe(50);
      expect(grant.source).toBe(CreditGrantSource.SUBSCRIPTION);
    });

    it('Pro credits do not carry over into Free', async () => {
      const proSubscription = randomUUID();
      const freeSubscription = randomUUID();
      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: proSubscription,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: await planCredits('pro'),
      });
      await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 20,
        entitlement: PRO_ACTIVE,
      });
      // 80 unspent Pro credits remain.

      await credits.expireSubscriptionGrants(proSubscription);
      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: freeSubscription,
        creditPeriodStart: FEB,
        creditPeriodEnd: MAR,
        amount: await planCredits('free'),
      });

      const balance = await credits.getBalance(userId, productId, FREE_ACTIVE);
      expect(balance.spendable).toBe(50);
      expect(balance.spendable).not.toBe(80);
      expect(balance.spendable).not.toBe(130);
    });

    it('Add-on credits are not expired by the transition', async () => {
      const proSubscription = randomUUID();
      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: proSubscription,
        creditPeriodStart: JAN,
        creditPeriodEnd: FEB,
        amount: 100,
      });
      const addon = await createGrant({
        source: CreditGrantSource.ADDON,
        amount: 200,
        priority: 200,
        addonPurchaseId: randomUUID(),
        subscriptionId: null,
      });

      await credits.expireSubscriptionGrants(proSubscription);

      const after = await testDatabase.prisma.creditGrant.findUniqueOrThrow({
        where: { id: addon.id },
      });
      expect(after.amountRemaining).toBe(200);
      expect(after.expiresAt).toBeNull();
      expect(
        await testDatabase.prisma.creditTransaction.count({
          where: {
            creditGrantId: addon.id,
            type: CreditTransactionType.EXPIRY,
          },
        }),
      ).toBe(0);

      // Frozen, not expired: unspendable on Free, spendable again on a paid plan.
      const onFree = await credits.getBalance(userId, productId, FREE_ACTIVE);
      expect(onFree).toMatchObject({ spendable: 0, frozen: 200 });
    });
  });
});
