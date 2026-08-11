import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { BillingCycle, Plan, Subscription, SubscriptionStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '@/common/clock/clock';
import { FixedClock } from '@/common/clock/fixed-clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BillingModule } from '../billing.module';
import { ALLOCATION_KEYS } from '../billing.constants';
import { FakeStripeAdapter } from '../stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { AnnualAllocationService } from './annual-allocation.service';

const NOW = new Date('2026-06-15T00:00:00.000Z');
const BOUNDARY = new Date('2027-01-01T00:00:00.000Z');
const JUNE = new Date('2026-06-01T00:00:00.000Z');
const JULY = new Date('2026-07-01T00:00:00.000Z');
const APRIL = new Date('2026-04-01T00:00:00.000Z');

describe('granting annual subscriptions their months', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let allocation: AnnualAllocationService;
  let clock: FixedClock;
  let plan: Plan;

  beforeAll(async () => {
    clock = new FixedClock(NOW);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        BillingModule,
      ],
    })
      .overrideProvider(StripeService)
      .useFactory({ factory: (at: Clock) => new FakeStripeAdapter(at), inject: [Clock] })
      .overrideProvider(Clock)
      .useValue(clock)
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    allocation = moduleRef.get(AnnualAllocationService);
    plan = await prisma.plan.findFirstOrThrow({
      where: { code: 'pro', cycle: BillingCycle.ANNUAL },
    });
  });

  beforeEach(() => clock.set(NOW));

  afterAll(async () => {
    await moduleRef.close();
  });

  async function anAnnualSubscriber(
    nextCreditAt: Date | null,
    status: SubscriptionStatus = SubscriptionStatus.ACTIVE,
    paidThroughAt: Date | null = BOUNDARY,
  ): Promise<Subscription> {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });

    await prisma.creditWallet.create({ data: { userId: user.id } });

    return prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status,
        cycle: BillingCycle.ANNUAL,
        paidThroughAt,
        nextCreditAt,
      },
    });
  }

  async function keysOf(subscription: Subscription): Promise<string[]> {
    const rows = await prisma.creditTransaction.findMany({
      where: { wallet: { userId: subscription.userId } },
      select: { idempotencyKey: true },
      orderBy: { idempotencyKey: 'asc' },
    });

    return rows.map((row) => row.idempotencyKey ?? '');
  }

  function walletOf(subscription: Subscription) {
    return prisma.creditWallet.findUniqueOrThrow({ where: { userId: subscription.userId } });
  }

  function reload(subscription: Subscription): Promise<Subscription> {
    return prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
  }

  it('grants the month a due subscription has reached, and passes over one not yet current', async () => {
    const due = await anAnnualSubscriber(JUNE);
    const canceled = await anAnnualSubscriber(JUNE, SubscriptionStatus.CANCELED);
    const pending = await anAnnualSubscriber(JUNE, SubscriptionStatus.PENDING);

    expect(await allocation.run()).toMatchObject({ subscriptions: 2, grants: 2 });

    expect(await keysOf(due)).toEqual([ALLOCATION_KEYS.month(due.id, JUNE)]);
    expect(await keysOf(canceled)).toHaveLength(1);
    expect(await keysOf(pending)).toEqual([]);

    expect(await walletOf(due)).toMatchObject({ subscriptionCredits: plan.monthlyCredits });
    expect((await reload(due)).nextCreditAt).toEqual(JULY);
  });

  it('catches up three missed months as three grants under three distinct keys', async () => {
    const behind = await anAnnualSubscriber(APRIL);

    expect(await allocation.run()).toMatchObject({ grants: 3 });

    expect(await keysOf(behind)).toEqual([
      `sub:${behind.id}:2026-04`,
      `sub:${behind.id}:2026-05`,
      `sub:${behind.id}:2026-06`,
    ]);
    expect((await reload(behind)).nextCreditAt).toEqual(JULY);
  });

  it('walks a month-end term to its boundary and never grants the month past it', async () => {
    const boundary = new Date('2027-01-31T00:00:00.000Z');
    const term = await anAnnualSubscriber(
      new Date('2026-02-28T00:00:00.000Z'),
      SubscriptionStatus.ACTIVE,
      boundary,
    );
    clock.set(new Date('2027-06-01T00:00:00.000Z'));

    expect(await allocation.run()).toMatchObject({ grants: 11 });

    const keys = await keysOf(term);

    expect(new Set(keys).size).toBe(11);
    expect(keys).not.toContain(`sub:${term.id}:2027-01`);
    expect(keys.at(-1)).toBe(`sub:${term.id}:2026-12`);
    expect((await reload(term)).nextCreditAt).toEqual(boundary);
  });

  it('grants nothing on a second run over the same months', async () => {
    const subscription = await anAnnualSubscriber(APRIL);

    await allocation.run();

    expect(await allocation.run()).toMatchObject({ subscriptions: 0, grants: 0 });
    expect(await keysOf(subscription)).toHaveLength(3);
    expect(await walletOf(subscription)).toMatchObject({
      subscriptionCredits: plan.monthlyCredits * 3,
    });
  });
});
