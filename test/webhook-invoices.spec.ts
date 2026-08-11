import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { BillingCycle, Subscription, SubscriptionStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingModule } from '@/billing/billing.module';
import { FakeStripeAdapter } from '@/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { BILLING_REASONS, STRIPE_API_VERSION } from '@/billing/stripe/stripe.constants';
import { StripeInvoice, StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { WebhookService } from '@/billing/webhook/services/webhook.service';
import { OUTCOME_STATUSES, WEBHOOK_EVENT_TYPES } from '@/billing/webhook/webhook.constants';
import { WebhookModule } from '@/billing/webhook/webhook.module';
import { Clock } from '@/common/clock/clock';
import { FixedClock } from '@/common/clock/fixed-clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { MetricsModule } from '@/common/metrics/metrics.module';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';

const NOW = new Date('2026-08-15T09:30:00.000Z');
const PERIOD = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-09-01T00:00:00.000Z'),
};

describe('the invoice webhook handlers', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let webhook: WebhookService;
  let stripe: FakeStripeAdapter;
  const clock = new FixedClock(NOW);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
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
    clock.set(NOW);
    await moduleRef.close();
  });

  function planNamed(code: string, cycle: BillingCycle = BillingCycle.MONTHLY) {
    return prisma.plan.findFirstOrThrow({ where: { code, cycle } });
  }

  async function aSubscriber(planCode: string, cycle: BillingCycle = BillingCycle.MONTHLY) {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const plan = await planNamed(planCode, cycle);

    await prisma.billingCustomer.create({ data: { userId: user.id } });
    await prisma.creditWallet.create({ data: { userId: user.id } });

    const local = await prisma.subscription.create({
      data: { userId: user.id, planId: plan.id, status: SubscriptionStatus.ACTIVE, cycle },
    });
    const remote = await stripe.createSubscription({
      subscriptionId: local.id,
      userId: user.id,
      customerId: `cus_${crypto.randomUUID()}`,
      priceId: plan.stripePriceId,
    });

    return { user, local, remote, plan };
  }

  function anInvoiceEvent(type: string, invoice: StripeInvoice): StripeWebhookEvent {
    return {
      id: `evt_${crypto.randomUUID()}`,
      type,
      createdAt: clock.now(),
      apiVersion: STRIPE_API_VERSION,
      objectId: invoice.id,
      payload: { data: { object: { id: invoice.id } } },
    };
  }

  function walletOf(local: Subscription) {
    return prisma.creditWallet.findUniqueOrThrow({ where: { userId: local.userId } });
  }

  function allocationsFor(local: Subscription) {
    return prisma.creditTransaction.findMany({
      where: { wallet: { userId: local.userId }, type: 'ALLOCATION' },
    });
  }

  it('grants on a cycle invoice and nothing at all on a manual one', async () => {
    const { local, remote, plan } = await aSubscriber('pro');

    const manual = stripe.issueInvoiceFor(remote.id, {
      billingReason: 'manual',
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });
    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, manual));

    expect(await allocationsFor(local)).toHaveLength(0);

    const cycle = stripe.issueInvoiceFor(remote.id, {
      billingReason: BILLING_REASONS.subscriptionCycle,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });
    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, cycle));

    expect(await allocationsFor(local)).toMatchObject([{ amount: plan.monthlyCredits }]);
    expect(await walletOf(local)).toMatchObject({ subscriptionCredits: plan.monthlyCredits });
  });

  it('grants once for one invoice even when it is redelivered in a later month', async () => {
    const { local, remote, plan } = await aSubscriber('pro');
    const invoice = stripe.issueInvoiceFor(remote.id, {
      billingReason: BILLING_REASONS.subscriptionCycle,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });

    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, invoice));

    clock.set(new Date('2026-09-20T09:30:00.000Z'));
    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, invoice));
    clock.set(NOW);

    expect(await allocationsFor(local)).toHaveLength(1);
    expect(await walletOf(local)).toMatchObject({ subscriptionCredits: plan.monthlyCredits });
  });

  it('grants the Free plan its credits from a zero-amount invoice without recording a payment', async () => {
    const { local, remote, plan } = await aSubscriber('free');
    const invoice = stripe.issueInvoiceFor(remote.id, {
      billingReason: BILLING_REASONS.subscriptionCycle,
      amountDue: 0,
      amountPaid: 0,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });

    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, invoice));

    expect(await walletOf(local)).toMatchObject({ subscriptionCredits: plan.monthlyCredits });
    expect(await prisma.paymentTransaction.count({ where: { userId: local.userId } })).toBe(0);
  });

  it('freezes on a failed payment and thaws on the retry, leaving one payment record', async () => {
    const { local, remote } = await aSubscriber('pro');
    const invoice = stripe.issueInvoiceFor(remote.id, {
      billingReason: BILLING_REASONS.subscriptionCycle,
      amountDue: 2000,
      amountPaid: 0,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });

    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaymentFailed, invoice));

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: local.id } })).toMatchObject({
      status: 'PAST_DUE',
    });
    expect(await walletOf(local)).toMatchObject({ status: 'FROZEN' });

    const paid = stripe.issueInvoiceFor(remote.id, {
      ...invoice,
      amountPaid: 2000,
    });
    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, paid));

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: local.id } })).toMatchObject({
      status: 'ACTIVE',
    });
    expect(await walletOf(local)).toMatchObject({ status: 'ACTIVE' });
    expect(
      await prisma.paymentTransaction.findMany({ where: { userId: local.userId } }),
    ).toMatchObject([{ status: 'SUCCEEDED', amountCents: 2000, stripeInvoiceId: invoice.id }]);
  });

  it('dates the next credit only for an annual subscription, and the boundary for both', async () => {
    const annual = await aSubscriber('pro', BillingCycle.ANNUAL);
    const monthly = await aSubscriber('pro');

    for (const { remote } of [annual, monthly]) {
      const invoice = stripe.issueInvoiceFor(remote.id, {
        billingReason: BILLING_REASONS.subscriptionCycle,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
      });
      await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, invoice));
    }

    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: annual.local.id } }),
    ).toMatchObject({
      paidThroughAt: PERIOD.end,
      nextCreditAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(
      await prisma.subscription.findUniqueOrThrow({ where: { id: monthly.local.id } }),
    ).toMatchObject({ paidThroughAt: PERIOD.end, nextCreditAt: null });
  });

  it('holds a downgrade until the renewal invoice, which grants the cheaper plan', async () => {
    const { local, remote, plan } = await aSubscriber('pro');
    const basic = await planNamed('free');

    await prisma.subscription.update({
      where: { id: local.id },
      data: { pendingPlanId: basic.id, pendingCycle: BillingCycle.MONTHLY },
    });
    await stripe.updateSubscription(remote.id, {
      priceId: basic.stripePriceId,
      prorationBehavior: 'none',
    });

    await webhook.ingest({
      id: `evt_${crypto.randomUUID()}`,
      type: WEBHOOK_EVENT_TYPES.subscriptionUpdated,
      createdAt: clock.now(),
      apiVersion: STRIPE_API_VERSION,
      objectId: remote.id,
      payload: { data: { object: { id: remote.id } } },
    });

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: local.id } })).toMatchObject({
      planId: plan.id,
      stripePriceId: basic.stripePriceId,
      pendingPlanId: basic.id,
    });

    const renewal = stripe.issueInvoiceFor(remote.id, {
      billingReason: BILLING_REASONS.subscriptionCycle,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });
    await webhook.ingest(anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, renewal));

    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: local.id } })).toMatchObject({
      planId: basic.id,
      pendingPlanId: null,
      pendingCycle: null,
    });
    expect(await allocationsFor(local)).toMatchObject([{ amount: basic.monthlyCredits }]);
  });

  it('writes nothing at all for an invoice Stripe has not marked paid', async () => {
    const { local, remote } = await aSubscriber('pro');
    const invoice = stripe.issueInvoiceFor(remote.id, {
      status: 'open',
      billingReason: BILLING_REASONS.subscriptionCycle,
      periodStart: PERIOD.start,
      periodEnd: PERIOD.end,
    });

    const outcome = await webhook.ingest(
      anInvoiceEvent(WEBHOOK_EVENT_TYPES.invoicePaid, invoice),
    );

    expect(outcome.status).toBe(OUTCOME_STATUSES.completed);
    expect(await allocationsFor(local)).toHaveLength(0);
    expect(await prisma.paymentTransaction.count({ where: { userId: local.userId } })).toBe(0);
  });
});
