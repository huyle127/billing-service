import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '@/common/clock/clock';
import { FixedClock } from '@/common/clock/fixed-clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BillingModule } from '../billing.module';
import { ALLOCATION_KEYS, ALLOCATION_REASONS, FREE_PLAN } from '../billing.constants';
import { FakeStripeAdapter } from '../stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { EntitlementService } from './entitlement.service';
import { SubscriptionAllocationService } from './subscription-allocation.service';

const NOW = new Date('2026-08-15T09:30:00.000Z');

describe('the registration grant', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let entitlement: EntitlementService;
  let allocation: SubscriptionAllocationService;
  const clock = new FixedClock(NOW);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        BillingModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(StripeService)
      .useFactory({ factory: () => new FakeStripeAdapter(clock) })
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    entitlement = moduleRef.get(EntitlementService);
    allocation = moduleRef.get(SubscriptionAllocationService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  function aUser(): Promise<User> {
    return prisma.user.create({ data: { email: `${crypto.randomUUID()}@example.test` } });
  }

  async function aGrantedUser(): Promise<User> {
    const user = await aUser();

    await prisma.$transaction((tx) => entitlement.grantOnRegistration(tx, user));

    return user;
  }

  function freePlan() {
    return prisma.plan.findFirstOrThrow({ where: { code: FREE_PLAN.code, cycle: FREE_PLAN.cycle } });
  }

  it('writes the customer, the Free subscription, the wallet and the grant, with no Stripe id', async () => {
    const plan = await freePlan();
    const user = await aGrantedUser();

    expect(
      await prisma.billingCustomer.findUniqueOrThrow({ where: { userId: user.id } }),
    ).toMatchObject({ stripeCustomerId: null, syncAttempts: 0, syncError: null });

    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    expect(subscription).toMatchObject({
      planId: plan.id,
      status: 'ACTIVE',
      cycle: FREE_PLAN.cycle,
      startedAt: NOW,
      stripeSubscriptionId: null,
      stripePriceId: null,
      stripeStatus: null,
      paidThroughAt: null,
      nextCreditAt: null,
    });

    const wallet = await prisma.creditWallet.findUniqueOrThrow({ where: { userId: user.id } });
    expect(wallet).toMatchObject({
      status: 'ACTIVE',
      subscriptionCredits: plan.monthlyCredits,
      addonCredits: 0,
    });

    expect(
      await prisma.creditTransaction.findMany({ where: { walletId: wallet.id } }),
    ).toMatchObject([
      {
        ledger: 'SUBSCRIPTION',
        type: 'ALLOCATION',
        amount: plan.monthlyCredits,
        balanceAfter: plan.monthlyCredits,
        reason: ALLOCATION_REASONS.registration,
      },
    ]);
  });

  it('grants through the allocation owner, so asking it again for the same month grants nothing further', async () => {
    const plan = await freePlan();
    const user = await aGrantedUser();
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    const wallet = await prisma.creditWallet.findUniqueOrThrow({ where: { userId: user.id } });

    expect(
      await prisma.creditTransaction.findFirstOrThrow({ where: { walletId: wallet.id } }),
    ).toMatchObject({ idempotencyKey: ALLOCATION_KEYS.month(subscription.id, NOW) });

    await prisma.$transaction((tx) =>
      allocation.grantMonth(tx, {
        userId: user.id,
        subscriptionId: subscription.id,
        monthlyCredits: plan.monthlyCredits,
        month: NOW,
        reason: ALLOCATION_REASONS.registration,
      }),
    );

    expect(
      await prisma.creditWallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toMatchObject({ subscriptionCredits: plan.monthlyCredits });
    expect(await prisma.creditTransaction.count({ where: { walletId: wallet.id } })).toBe(1);
  });

  it('writes nothing at all when the catalog holds no active Free plan', async () => {
    const user = await aUser();

    await prisma.plan.updateMany({ where: { code: FREE_PLAN.code }, data: { active: false } });

    try {
      await expect(
        prisma.$transaction((tx) => entitlement.grantOnRegistration(tx, user)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await prisma.plan.updateMany({ where: { code: FREE_PLAN.code }, data: { active: true } });
    }

    expect(await prisma.billingCustomer.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.creditWallet.count({ where: { userId: user.id } })).toBe(0);
  });
});
