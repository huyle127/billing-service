import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { BillingCycle, Plan, SubscriptionStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '@/common/clock/clock';
import { FixedClock } from '@/common/clock/fixed-clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BillingModule } from '../billing.module';
import { PlanInUseError } from '../billing.errors';
import { FakeStripeAdapter } from '../stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { CatalogService } from './catalog.service';

const NOW = new Date('2026-08-11T00:00:00.000Z');
const DRAFT = 'plan_draft_';

describe('managing the plan catalog', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let catalog: CatalogService;
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

  function aPlanDraft(cycle: BillingCycle = BillingCycle.MONTHLY, amountCents = 3000) {
    const code = `${DRAFT}${crypto.randomUUID().slice(0, 8)}`;

    return { code, name: 'Team', cycle, monthlyCredits: 300, amountCents, currency: 'usd' };
  }

  async function aSubscriberOn(plan: Plan): Promise<void> {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });

    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        cycle: plan.cycle,
        stripePriceId: plan.stripePriceId,
      },
    });
  }

  it('gives a resubmitted create one Price, and the second cycle of a code the same Product', async () => {
    const draft = aPlanDraft();

    const monthly = await catalog.createPlan(draft);
    await expect(catalog.createPlan(draft)).rejects.toThrow();

    expect(await stripe.findPricesByPlanCode(draft.code)).toEqual([
      expect.objectContaining({ id: monthly.stripePriceId }),
    ]);

    const annual = await catalog.createPlan({ ...draft, cycle: BillingCycle.ANNUAL });

    expect(annual.stripeProductId).toBe(monthly.stripeProductId);
    expect(annual.stripePriceId).not.toBe(monthly.stripePriceId);
  });

  it('mints a new Price on a reprice, archives the old, and repoints the plan', async () => {
    const created = await catalog.createPlan(aPlanDraft());

    const revised = await catalog.revisePlan(created.id, { amountCents: 4500 });

    expect(revised.stripePriceId).not.toBe(created.stripePriceId);
    expect(revised.amountCents).toBe(4500);

    const prices = await stripe.findPricesByPlanCode(created.code);
    expect(prices.find((price) => price.id === created.stripePriceId)?.active).toBe(false);
    expect(prices.find((price) => price.id === revised.stripePriceId)?.active).toBe(true);
  });

  it('refuses to archive a plan an active subscription points at', async () => {
    const created = await catalog.createPlan(aPlanDraft());
    await aSubscriberOn(created);

    await expect(catalog.archivePlan(created.id)).rejects.toBeInstanceOf(PlanInUseError);

    const reloaded = await prisma.plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(reloaded.active).toBe(true);
  });
});
