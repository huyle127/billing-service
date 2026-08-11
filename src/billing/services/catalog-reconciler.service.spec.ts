import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { BillingCycle, Plan, Subscription, SubscriptionStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../../common/clock/clock';
import { FixedClock } from '../../common/clock/fixed-clock';
import { AppConfigModule } from '../../common/config/config.module';
import { configurations } from '../../common/config/configuration';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BillingModule } from '../billing.module';
import { FakeStripeAdapter } from '../stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { CatalogReconcilerService } from './catalog-reconciler.service';
import { CatalogService } from './catalog.service';

const NOW = new Date('2026-08-11T00:00:00.000Z');
const DRAFT = 'plan_migrate_';

describe('migrating subscribers onto a repriced plan', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let catalog: CatalogService;
  let reconciler: CatalogReconcilerService;
  let stripe: FakeStripeAdapter;

  beforeAll(async () => {
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
      .useValue(new FixedClock(NOW))
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    catalog = moduleRef.get(CatalogService);
    reconciler = moduleRef.get(CatalogReconcilerService);
    stripe = moduleRef.get(StripeService) as unknown as FakeStripeAdapter;

    await dropDrafts();
  });

  afterAll(async () => {
    await dropDrafts();
    await moduleRef.close();
  });

  async function dropDrafts(): Promise<void> {
    await prisma.subscription.deleteMany({ where: { plan: { code: { startsWith: DRAFT } } } });
    await prisma.plan.deleteMany({ where: { code: { startsWith: DRAFT } } });
  }

  function aPlanDraft() {
    return {
      code: `${DRAFT}${crypto.randomUUID().slice(0, 8)}`,
      name: 'Team',
      cycle: BillingCycle.MONTHLY,
      monthlyCredits: 300,
      amountCents: 3000,
    };
  }

  async function aSubscriberOn(plan: Plan): Promise<Subscription> {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    await prisma.creditWallet.create({ data: { userId: user.id } });

    const customer = await stripe.createCustomer({ userId: user.id, email: user.email });
    const subscriptionId = crypto.randomUUID();
    const remote = await stripe.createSubscription({
      customerId: customer.id,
      priceId: plan.stripePriceId,
      userId: user.id,
      subscriptionId,
    });

    return prisma.subscription.create({
      data: {
        id: subscriptionId,
        userId: user.id,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        cycle: plan.cycle,
        stripeSubscriptionId: remote.id,
        stripePriceId: plan.stripePriceId,
      },
    });
  }

  async function aRepricedPlanWithASubscriber(): Promise<{
    subscription: Subscription;
    revised: Plan;
  }> {
    const plan = await catalog.createPlan(aPlanDraft());
    const subscription = await aSubscriberOn(plan);
    const revised = await catalog.revisePlan(plan.id, { amountCents: 4500 });

    return { subscription, revised };
  }

  function reload(subscription: Subscription): Promise<Subscription> {
    return prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
  }

  it('moves a mispriced active subscription onto its plan price with no proration', async () => {
    const { subscription, revised } = await aRepricedPlanWithASubscriber();

    expect(await reconciler.migrateSubscribers()).toBe(1);

    expect((await reload(subscription)).stripePriceId).toBe(revised.stripePriceId);
    expect(stripe.lastSubscriptionUpdate()).toMatchObject({
      priceId: revised.stripePriceId,
      prorationBehavior: 'none',
    });
  });

  it('finds nothing on a second run', async () => {
    await aRepricedPlanWithASubscriber();

    expect(await reconciler.migrateSubscribers()).toBe(1);
    expect(await reconciler.migrateSubscribers()).toBe(0);
  });

  it('grants no credits across a reprice and its migration', async () => {
    const { subscription } = await aRepricedPlanWithASubscriber();

    await reconciler.migrateSubscribers();

    const wallet = await prisma.creditWallet.findUniqueOrThrow({
      where: { userId: subscription.userId },
    });
    const transactions = await prisma.creditTransaction.count({ where: { walletId: wallet.id } });

    expect(wallet).toMatchObject({ subscriptionCredits: 0, addonCredits: 0 });
    expect(transactions).toBe(0);
  });

  it('names a Stripe price the catalog never recorded', async () => {
    const plan = await catalog.createPlan(aPlanDraft());
    const orphan = await stripe.createPrice({
      code: plan.code,
      productId: plan.stripeProductId as string,
      unitAmount: 9900,
      currency: 'usd',
      interval: 'month',
    });

    expect(await reconciler.reportOrphanPrices()).toContain(orphan.id);
  });
});
