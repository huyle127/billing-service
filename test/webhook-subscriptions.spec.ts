import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Subscription, SubscriptionStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingModule } from '../src/billing/billing.module';
import { FREE_PLAN } from '../src/billing/billing.constants';
import { FakeStripeAdapter } from '../src/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../src/billing/stripe/interfaces/stripe-adapter.interface';
import {
  BILLING_REASONS,
  STRIPE_API_VERSION,
} from '../src/billing/stripe/stripe.constants';
import { StripeWebhookEvent } from '../src/billing/stripe/types/stripe.types';
import { WebhookService } from '../src/billing/webhook/services/webhook.service';
import {
  OUTCOME_STATUSES,
  WEBHOOK_EVENT_TYPES,
} from '../src/billing/webhook/webhook.constants';
import { WebhookModule } from '../src/billing/webhook/webhook.module';
import { Clock } from '../src/common/clock/clock';
import { FixedClock } from '../src/common/clock/fixed-clock';
import { AppConfigModule } from '../src/common/config/config.module';
import { configurations } from '../src/common/config/configuration';
import { MetricsModule } from '../src/common/metrics/metrics.module';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

const NOW = new Date('2026-08-15T09:30:00.000Z');
const HELD = { subscription: 400, addon: 90 };
const STALE_PRICE = 'price_the_payload_still_believes_in';

describe('the subscription webhook handlers', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let webhook: WebhookService;
  let stripe: FakeStripeAdapter;
  const clock = new FixedClock(NOW);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: configurations,
          cache: true,
        }),
        AppConfigModule,
        PrismaModule,
        MetricsModule,
        BillingModule,
        WebhookModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(StripeService)
      .useFactory({ factory: () => new FakeStripeAdapter(clock) })
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    webhook = moduleRef.get(WebhookService);
    stripe = moduleRef.get(StripeService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  function planNamed(code: string) {
    return prisma.plan.findFirstOrThrow({ where: { code, cycle: 'MONTHLY' } });
  }

  async function aSubscriber(planCode: string, status: SubscriptionStatus) {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const plan = await planNamed(planCode);

    await prisma.billingCustomer.create({ data: { userId: user.id } });
    await prisma.creditWallet.create({
      data: {
        userId: user.id,
        subscriptionCredits: HELD.subscription,
        addonCredits: HELD.addon,
      },
    });

    const local = await prisma.subscription.create({
      data: { userId: user.id, planId: plan.id, status, cycle: 'MONTHLY' },
    });

    return { user, local };
  }

  async function stripeSubscriptionFor(
    localId: string,
    userId: string,
    priceId: string,
  ) {
    return stripe.createSubscription({
      subscriptionId: localId,
      userId,
      customerId: `cus_${crypto.randomUUID()}`,
      priceId,
    });
  }

  function anEvent(type: string, objectId: string): StripeWebhookEvent {
    return {
      id: `evt_${crypto.randomUUID()}`,
      type,
      createdAt: clock.now(),
      apiVersion: STRIPE_API_VERSION,
      objectId,
      payload: {
        data: { object: { items: { data: [{ price: { id: STALE_PRICE } }] } } },
      },
    };
  }

  function reload(local: Subscription) {
    return prisma.subscription.findUniqueOrThrow({ where: { id: local.id } });
  }

  it('defers an event whose subject has no local row, and writes no subscription', async () => {
    const orphan = await stripeSubscriptionFor(
      crypto.randomUUID(),
      crypto.randomUUID(),
      (await planNamed('pro')).stripePriceId,
    );
    const before = await prisma.subscription.count();

    const outcome = await webhook.ingest(
      anEvent(WEBHOOK_EVENT_TYPES.subscriptionCreated, orphan.id),
    );

    expect(outcome.status).toBe(OUTCOME_STATUSES.deferred);
    expect(await prisma.subscription.count()).toBe(before);
  });

  it('attaches the Stripe id once, however often the created event is delivered', async () => {
    const { user, local } = await aSubscriber(
      'pro',
      SubscriptionStatus.PENDING,
    );
    const pro = await planNamed('pro');
    const remote = await stripeSubscriptionFor(
      local.id,
      user.id,
      pro.stripePriceId,
    );

    for (const _ of [1, 2]) {
      const outcome = await webhook.ingest(
        anEvent(WEBHOOK_EVENT_TYPES.subscriptionCreated, remote.id),
      );
      expect(outcome.status).toBe(OUTCOME_STATUSES.completed);
    }

    expect(await reload(local)).toMatchObject({
      stripeSubscriptionId: remote.id,
      syncAttempts: 0,
      syncError: null,
      status: SubscriptionStatus.PENDING,
    });
    expect(
      await prisma.subscription.count({ where: { userId: user.id } }),
    ).toBe(1);
  });

  it('records an attached payment method once and forgets it on detach, however often replayed', async () => {
    const { user } = await aSubscriber('pro', SubscriptionStatus.ACTIVE);
    const customerId = `cus_${crypto.randomUUID()}`;
    const paymentMethodId = `pm_${crypto.randomUUID()}`;

    await prisma.billingCustomer.update({
      where: { userId: user.id },
      data: { stripeCustomerId: customerId },
    });
    await stripe.attachPaymentMethod({ customerId, paymentMethodId, setAsDefault: true });

    for (const _ of [1, 2]) {
      const outcome = await webhook.ingest(
        anEvent(WEBHOOK_EVENT_TYPES.paymentMethodAttached, paymentMethodId),
      );
      expect(outcome.status).toBe(OUTCOME_STATUSES.completed);
    }

    expect(await prisma.paymentMethod.findMany({ where: { userId: user.id } })).toMatchObject([
      { stripePaymentMethodId: paymentMethodId, brand: 'visa', last4: '4242', isDefault: true },
    ]);

    for (const _ of [1, 2]) {
      const outcome = await webhook.ingest(
        anEvent(WEBHOOK_EVENT_TYPES.paymentMethodDetached, paymentMethodId),
      );
      expect(outcome.status).toBe(OUTCOME_STATUSES.completed);
    }

    expect(await prisma.paymentMethod.findMany({ where: { userId: user.id } })).toMatchObject([
      { stripePaymentMethodId: paymentMethodId, detachedAt: NOW, isDefault: false },
    ]);
  });

  it('applies the price Stripe holds over the one the payload carries, and allocates nothing', async () => {
    const { user, local } = await aSubscriber(
      'free',
      SubscriptionStatus.ACTIVE,
    );
    const pro = await planNamed('pro');
    const remote = await stripeSubscriptionFor(
      local.id,
      user.id,
      pro.stripePriceId,
    );

    const outcome = await webhook.ingest(
      anEvent(WEBHOOK_EVENT_TYPES.subscriptionUpdated, remote.id),
    );

    expect(outcome.status).toBe(OUTCOME_STATUSES.completed);
    expect(await reload(local)).toMatchObject({
      planId: pro.id,
      stripePriceId: pro.stripePriceId,
      stripePeriodEnd: remote.currentPeriodEnd,
    });
    expect(
      await prisma.creditTransaction.count({
        where: { wallet: { userId: user.id } },
      }),
    ).toBe(0);
  });

  it('leaves everything alone when the event resolves to a superseded period', async () => {
    const { user, local } = await aSubscriber(
      'free',
      SubscriptionStatus.ACTIVE,
    );
    const free = await planNamed('free');
    const pro = await planNamed('pro');
    const remote = await stripeSubscriptionFor(
      local.id,
      user.id,
      pro.stripePriceId,
    );
    const ahead = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);

    await prisma.subscription.update({
      where: { id: local.id },
      data: { stripePeriodEnd: ahead },
    });

    const outcome = await webhook.ingest(
      anEvent(WEBHOOK_EVENT_TYPES.subscriptionUpdated, remote.id),
    );

    expect(outcome.status).toBe(OUTCOME_STATUSES.completed);
    expect(await reload(local)).toMatchObject({
      planId: free.id,
      stripePriceId: null,
      stripePeriodEnd: ahead,
      status: SubscriptionStatus.ACTIVE,
    });
  });

  it('cancels through the transition table when Stripe reports cancel at period end', async () => {
    const { user, local } = await aSubscriber('pro', SubscriptionStatus.ACTIVE);
    const pro = await planNamed('pro');
    const remote = await stripeSubscriptionFor(
      local.id,
      user.id,
      pro.stripePriceId,
    );
    await stripe.cancelSubscription(remote.id, { atPeriodEnd: true });

    await webhook.ingest(
      anEvent(WEBHOOK_EVENT_TYPES.subscriptionUpdated, remote.id),
    );

    expect(await reload(local)).toMatchObject({
      status: SubscriptionStatus.CANCELED,
      canceledAt: NOW,
    });

    const free = await planNamed('free');
    await expect(
      prisma.subscription.create({
        data: {
          userId: user.id,
          planId: free.id,
          status: 'ACTIVE',
          cycle: FREE_PLAN.cycle,
        },
      }),
    ).rejects.toThrow();
  });

  it('expires on deletion, forfeiting subscription credits and replacing the row with Free', async () => {
    const { user, local } = await aSubscriber('pro', SubscriptionStatus.ACTIVE);
    const pro = await planNamed('pro');
    const free = await planNamed('free');
    const remote = await stripeSubscriptionFor(
      local.id,
      user.id,
      pro.stripePriceId,
    );

    await webhook.ingest(
      anEvent(WEBHOOK_EVENT_TYPES.subscriptionDeleted, remote.id),
    );

    expect(await reload(local)).toMatchObject({
      status: SubscriptionStatus.EXPIRED,
      endedAt: NOW,
    });
    expect(
      await prisma.creditWallet.findUniqueOrThrow({
        where: { userId: user.id },
      }),
    ).toMatchObject({ subscriptionCredits: 0, addonCredits: HELD.addon });
    expect(
      await prisma.subscription.findFirstOrThrow({
        where: { userId: user.id, status: 'ACTIVE' },
      }),
    ).toMatchObject({ planId: free.id, stripeSubscriptionId: null });
  });

  it('converges on the same rows whether the history arrives in order or shuffled', async () => {
    const pro = await planNamed('pro');

    async function replay(
      order: (events: StripeWebhookEvent[]) => StripeWebhookEvent[],
    ) {
      const { user, local } = await aSubscriber(
        'pro',
        SubscriptionStatus.ACTIVE,
      );
      const remote = await stripeSubscriptionFor(
        local.id,
        user.id,
        pro.stripePriceId,
      );
      await stripe.cancelSubscription(remote.id, { atPeriodEnd: true });

      const created = anEvent(
        WEBHOOK_EVENT_TYPES.subscriptionCreated,
        remote.id,
      );
      const invoice = stripe.issueInvoiceFor(remote.id, {
        billingReason: BILLING_REASONS.subscriptionCycle,
        amountDue: 2000,
        amountPaid: 2000,
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-09-01T00:00:00.000Z'),
      });
      const events = [
        created,
        anEvent(WEBHOOK_EVENT_TYPES.subscriptionUpdated, remote.id),
        created,
        anEvent(WEBHOOK_EVENT_TYPES.invoicePaymentFailed, invoice.id),
        anEvent(WEBHOOK_EVENT_TYPES.invoicePaid, invoice.id),
        anEvent(WEBHOOK_EVENT_TYPES.subscriptionUpdated, remote.id),
        anEvent(WEBHOOK_EVENT_TYPES.subscriptionDeleted, remote.id),
      ];

      for (const event of order(events)) {
        await webhook.ingest(event);
      }

      return {
        subscription: await reload(local),
        wallet: await prisma.creditWallet.findUniqueOrThrow({
          where: { userId: user.id },
        }),
        rows: await prisma.subscription.count({ where: { userId: user.id } }),
        payments: await prisma.paymentTransaction.count({ where: { userId: user.id } }),
        allocations: await prisma.creditTransaction.count({
          where: { wallet: { userId: user.id }, type: 'ALLOCATION' },
        }),
      };
    }

    const ordered = await replay((events) => events);
    const reversed = await replay((events) => [...events].reverse());
    const interleaved = await replay((events) => [
      events[6],
      events[4],
      events[1],
      events[0],
      events[3],
      events[5],
      events[2],
    ]);

    for (const shuffled of [reversed, interleaved]) {
      expect(shuffled.subscription.status).toBe(ordered.subscription.status);
      expect(shuffled.subscription.planId).toBe(ordered.subscription.planId);
      expect(shuffled.subscription.stripePriceId).toBe(
        ordered.subscription.stripePriceId,
      );
      expect(shuffled.subscription.stripePeriodEnd).toEqual(
        ordered.subscription.stripePeriodEnd,
      );
      expect(shuffled.wallet.subscriptionCredits).toBe(
        ordered.wallet.subscriptionCredits,
      );
      expect(shuffled.wallet.addonCredits).toBe(ordered.wallet.addonCredits);
      expect(shuffled.wallet.status).toBe(ordered.wallet.status);
      expect(shuffled.rows).toBe(ordered.rows);
      expect(shuffled.payments).toBe(ordered.payments);
      expect(shuffled.allocations).toBe(ordered.allocations);
    }

    expect(ordered.subscription.status).toBe(SubscriptionStatus.EXPIRED);
  }, 30_000);
});
