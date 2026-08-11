import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Subscription, SubscriptionStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '@/common/clock/clock';
import { FixedClock } from '@/common/clock/fixed-clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BillingModule } from '../billing.module';
import { FREE_PLAN, TRANSITION_REASONS } from '../billing.constants';
import { FakeStripeAdapter } from '../stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { APPLIED, SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { LIFECYCLE_EVENTS, UNCHANGED } from './subscription-transitions';

const NOW = new Date('2026-08-15T09:30:00.000Z');
const HELD = { subscription: 500, addon: 120 };

describe('the subscription lifecycle', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let lifecycle: SubscriptionLifecycleService;
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
    lifecycle = moduleRef.get(SubscriptionLifecycleService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  function freePlan() {
    return prisma.plan.findFirstOrThrow({ where: { code: FREE_PLAN.code, cycle: FREE_PLAN.cycle } });
  }

  async function aSubscriber(status: SubscriptionStatus): Promise<Subscription> {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const plan = await prisma.plan.findFirstOrThrow({ where: { code: 'pro', cycle: 'MONTHLY' } });

    await prisma.creditWallet.create({
      data: {
        userId: user.id,
        subscriptionCredits: HELD.subscription,
        addonCredits: HELD.addon,
      },
    });

    return prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status,
        cycle: 'MONTHLY',
        stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
        stripeStatus: 'active',
      },
    });
  }

  function reload(subscription: Subscription) {
    return prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
  }

  function wallet(subscription: Subscription) {
    return prisma.creditWallet.findUniqueOrThrow({ where: { userId: subscription.userId } });
  }

  function eventsOf(subscription: Subscription) {
    return prisma.subscriptionEvent.findMany({
      where: { subscriptionId: subscription.id },
      orderBy: { occurredAt: 'asc' },
    });
  }

  it('supersedes the current subscription when a pending one activates, forfeiting its credits', async () => {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const free = await freePlan();
    const pro = await prisma.plan.findFirstOrThrow({ where: { code: 'pro', cycle: 'MONTHLY' } });

    await prisma.creditWallet.create({
      data: { userId: user.id, subscriptionCredits: 20, addonCredits: HELD.addon },
    });

    const current = await prisma.subscription.create({
      data: { userId: user.id, planId: free.id, status: 'ACTIVE', cycle: FREE_PLAN.cycle },
    });
    const pending = await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: pro.id,
        status: 'PENDING',
        cycle: 'MONTHLY',
        stripeSubscriptionId: `sub_${crypto.randomUUID()}`,
      },
    });

    const outcome = await lifecycle.apply({
      subscriptionId: pending.id,
      event: LIFECYCLE_EVENTS.renew,
      reason: TRANSITION_REASONS.renewed,
      stripeEventId: 'evt_first_invoice_paid',
      stripeStatus: 'active',
    });

    expect(outcome).toBe(APPLIED);
    expect(await reload(current)).toMatchObject({ status: 'EXPIRED', endedAt: NOW });
    expect(await reload(pending)).toMatchObject({ status: 'ACTIVE' });
    expect(await wallet(pending)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: HELD.addon,
    });
    expect(await eventsOf(current)).toMatchObject([
      { type: 'EXPIRED', reason: TRANSITION_REASONS.superseded },
    ]);
    expect(
      await prisma.creditTransaction.findMany({ where: { wallet: { userId: user.id } } }),
    ).toMatchObject([{ ledger: 'SUBSCRIPTION', type: 'RESET', amount: -20, balanceAfter: 0 }]);
    expect(
      await prisma.subscription.findMany({ where: { userId: user.id, status: 'ACTIVE' } }),
    ).toMatchObject([{ id: pending.id }]);
  });

  it('answers unchanged for a transition the table does not carry, writing no status and no event', async () => {
    const subscription = await aSubscriber(SubscriptionStatus.EXPIRED);

    const outcome = await lifecycle.apply({
      subscriptionId: subscription.id,
      event: LIFECYCLE_EVENTS.expire,
      reason: TRANSITION_REASONS.expired,
      stripeEventId: 'evt_late_delete',
      stripeStatus: 'canceled',
    });

    expect(outcome).toBe(UNCHANGED);
    expect(await reload(subscription)).toMatchObject({
      status: 'EXPIRED',
      stripeStatus: 'active',
      endedAt: null,
    });
    expect(await eventsOf(subscription)).toHaveLength(0);
    expect(await prisma.subscription.count({ where: { userId: subscription.userId } })).toBe(1);
  });

  it('cancels without releasing the current slot or touching the balance', async () => {
    const subscription = await aSubscriber(SubscriptionStatus.ACTIVE);

    const outcome = await lifecycle.apply({
      subscriptionId: subscription.id,
      event: LIFECYCLE_EVENTS.cancel,
      reason: TRANSITION_REASONS.canceled,
      stripeEventId: 'evt_cancel',
      stripeStatus: 'active',
    });

    expect(outcome).toBe(APPLIED);
    expect(await reload(subscription)).toMatchObject({
      status: 'CANCELED',
      canceledAt: NOW,
      endedAt: null,
      stripeStatus: 'active',
    });
    expect(await eventsOf(subscription)).toMatchObject([
      {
        type: 'CANCELED',
        reason: TRANSITION_REASONS.canceled,
        stripeEventId: 'evt_cancel',
      },
    ]);
    expect(await wallet(subscription)).toMatchObject({
      status: 'ACTIVE',
      subscriptionCredits: HELD.subscription,
      addonCredits: HELD.addon,
    });

    const free = await freePlan();
    await expect(
      prisma.subscription.create({
        data: {
          userId: subscription.userId,
          planId: free.id,
          status: 'ACTIVE',
          cycle: FREE_PLAN.cycle,
        },
      }),
    ).rejects.toThrow();
  });

  it('freezes the wallet on past due and unfreezes on resolution, allocating nothing either way', async () => {
    const subscription = await aSubscriber(SubscriptionStatus.ACTIVE);

    await lifecycle.apply({
      subscriptionId: subscription.id,
      event: LIFECYCLE_EVENTS.pastDue,
      reason: TRANSITION_REASONS.pastDue,
      stripeEventId: 'evt_payment_failed',
    });

    expect(await reload(subscription)).toMatchObject({ status: 'PAST_DUE' });
    expect(await wallet(subscription)).toMatchObject({ status: 'FROZEN' });

    await lifecycle.apply({
      subscriptionId: subscription.id,
      event: LIFECYCLE_EVENTS.renew,
      reason: TRANSITION_REASONS.renewed,
      stripeEventId: 'evt_invoice_paid',
    });

    expect(await reload(subscription)).toMatchObject({ status: 'ACTIVE' });
    expect(await wallet(subscription)).toMatchObject({
      status: 'ACTIVE',
      subscriptionCredits: HELD.subscription,
      addonCredits: HELD.addon,
    });
    expect((await eventsOf(subscription)).map((event) => event.type)).toEqual([
      'PAST_DUE',
      'RENEWED',
    ]);
    expect(
      await prisma.creditTransaction.count({
        where: { wallet: { userId: subscription.userId } },
      }),
    ).toBe(0);
  });

  it('leaves the wallet spendable when dunning gives up on a past due subscription', async () => {
    const subscription = await aSubscriber(SubscriptionStatus.PAST_DUE);

    await prisma.creditWallet.update({
      where: { userId: subscription.userId },
      data: { status: 'FROZEN' },
    });

    const outcome = await lifecycle.apply({
      subscriptionId: subscription.id,
      event: LIFECYCLE_EVENTS.expire,
      reason: TRANSITION_REASONS.expired,
      stripeEventId: 'evt_dunning_gave_up',
    });

    expect(outcome).toBe(APPLIED);
    expect(await reload(subscription)).toMatchObject({ status: 'EXPIRED' });
    expect(await wallet(subscription)).toMatchObject({
      status: 'ACTIVE',
      subscriptionCredits: 0,
    });
    expect(
      await prisma.subscription.count({
        where: { userId: subscription.userId, status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('expires by forfeiting subscription credits and replacing the row with a Free subscription', async () => {
    const subscription = await aSubscriber(SubscriptionStatus.ACTIVE);
    const free = await freePlan();

    const outcome = await lifecycle.apply({
      subscriptionId: subscription.id,
      event: LIFECYCLE_EVENTS.expire,
      reason: TRANSITION_REASONS.expired,
      stripeEventId: 'evt_deleted',
      stripeStatus: 'canceled',
    });

    expect(outcome).toBe(APPLIED);
    expect(await reload(subscription)).toMatchObject({
      status: 'EXPIRED',
      endedAt: NOW,
      stripeStatus: 'canceled',
    });
    expect(await eventsOf(subscription)).toMatchObject([
      { type: 'EXPIRED', reason: TRANSITION_REASONS.expired, stripeEventId: 'evt_deleted' },
    ]);
    expect(await wallet(subscription)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: HELD.addon,
    });
    expect(
      await prisma.creditTransaction.findMany({
        where: { wallet: { userId: subscription.userId } },
      }),
    ).toMatchObject([
      {
        ledger: 'SUBSCRIPTION',
        type: 'RESET',
        amount: -HELD.subscription,
        balanceAfter: 0,
      },
    ]);

    const replacement = await prisma.subscription.findFirstOrThrow({
      where: { userId: subscription.userId, status: 'ACTIVE' },
    });
    expect(replacement).toMatchObject({
      planId: free.id,
      cycle: FREE_PLAN.cycle,
      startedAt: NOW,
      stripeSubscriptionId: null,
    });
  });

  it('cannot enter the Free row before the expiring row leaves the current set', async () => {
    const subscription = await aSubscriber(SubscriptionStatus.ACTIVE);
    const free = await freePlan();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.subscription.create({
          data: {
            userId: subscription.userId,
            planId: free.id,
            status: 'ACTIVE',
            cycle: FREE_PLAN.cycle,
          },
        });
        await tx.subscription.update({
          where: { id: subscription.id },
          data: { status: 'EXPIRED' },
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.subscription.count({ where: { userId: subscription.userId } })).toBe(1);
  });
});
