import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { PaymentStatus, User, WalletStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingModule } from '@/billing/billing.module';
import { ALLOCATION_KEYS } from '@/billing/billing.constants';
import { AddonPurchaseService } from '@/billing/services/addon-purchase.service';
import { FakeStripeAdapter } from '@/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { PAYMENT_STATUSES, STRIPE_API_VERSION } from '@/billing/stripe/stripe.constants';
import { StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { WebhookService } from '@/billing/webhook/services/webhook.service';
import { WEBHOOK_EVENT_TYPES } from '@/billing/webhook/webhook.constants';
import { WebhookModule } from '@/billing/webhook/webhook.module';
import { Clock } from '@/common/clock/clock';
import { FixedClock } from '@/common/clock/fixed-clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { MetricsModule } from '@/common/metrics/metrics.module';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';

const NOW = new Date('2026-08-15T09:30:00.000Z');
const SMALL = 'credits_small';

describe('buying add-on credits', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let purchases: AddonPurchaseService;
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
    purchases = moduleRef.get(AddonPurchaseService);
    webhook = moduleRef.get(WebhookService);
    stripe = moduleRef.get(StripeService);
  });

  afterAll(async () => {
    clock.set(NOW);
    await moduleRef.close();
  });

  async function aBuyer(status: WalletStatus = WalletStatus.ACTIVE): Promise<User> {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });

    await prisma.billingCustomer.create({ data: { userId: user.id } });
    await prisma.creditWallet.create({ data: { userId: user.id, status } });
    await prisma.paymentMethod.create({
      data: {
        userId: user.id,
        stripePaymentMethodId: `pm_${crypto.randomUUID()}`,
        isDefault: true,
      },
    });

    return user;
  }

  function aPaymentEvent(type: string, paymentIntentId: string): StripeWebhookEvent {
    return {
      id: `evt_${crypto.randomUUID()}`,
      type,
      createdAt: clock.now(),
      apiVersion: STRIPE_API_VERSION,
      objectId: paymentIntentId,
      payload: { data: { object: { id: paymentIntentId } } },
    };
  }

  function walletOf(user: User) {
    return prisma.creditWallet.findUniqueOrThrow({ where: { userId: user.id } });
  }

  function purchaseRow(purchaseId: string) {
    return prisma.paymentTransaction.findUniqueOrThrow({ where: { id: purchaseId } });
  }

  function allocationsFor(user: User) {
    return prisma.creditTransaction.findMany({
      where: { wallet: { userId: user.id }, type: 'ALLOCATION' },
    });
  }

  async function intentOf(purchaseId: string): Promise<string> {
    const row = await purchaseRow(purchaseId);

    return row.stripePaymentIntentId as string;
  }

  it('records the purchase as pending and grants nothing until the webhook arrives', async () => {
    const user = await aBuyer();

    const view = await purchases.purchase(user.id, { packageCode: SMALL });

    expect(view.providerStatus).toBe(PAYMENT_STATUSES.succeeded);
    expect(view.status).toBe(PaymentStatus.PENDING);

    const row = await purchaseRow(view.purchaseId);

    expect(row.status).toBe(PaymentStatus.PENDING);
    expect(row.addonPackageId).not.toBeNull();
    expect(row.stripePaymentIntentId).toMatch(/^pi_fake_/);
    expect((await walletOf(user)).addonCredits).toBe(0);
    expect(await allocationsFor(user)).toHaveLength(0);
  });

  it('grants the package credits and settles the payment when the intent succeeds', async () => {
    const user = await aBuyer();
    const view = await purchases.purchase(user.id, { packageCode: SMALL });

    await webhook.ingest(
      aPaymentEvent(WEBHOOK_EVENT_TYPES.paymentIntentSucceeded, await intentOf(view.purchaseId)),
    );

    expect((await walletOf(user)).addonCredits).toBe(view.credits);
    expect((await purchaseRow(view.purchaseId)).status).toBe(PaymentStatus.SUCCEEDED);

    const allocations = await allocationsFor(user);

    expect(allocations).toHaveLength(1);
    expect(allocations[0].idempotencyKey).toBe(ALLOCATION_KEYS.purchase(view.purchaseId));
    expect(allocations[0].ledger).toBe('ADDON');
  });

  it('grants once when the succeeded event is redelivered under a new event id', async () => {
    const user = await aBuyer();
    const view = await purchases.purchase(user.id, { packageCode: SMALL });
    const intentId = await intentOf(view.purchaseId);

    await webhook.ingest(aPaymentEvent(WEBHOOK_EVENT_TYPES.paymentIntentSucceeded, intentId));
    await webhook.ingest(aPaymentEvent(WEBHOOK_EVENT_TYPES.paymentIntentSucceeded, intentId));

    expect((await walletOf(user)).addonCredits).toBe(view.credits);
    expect(await allocationsFor(user)).toHaveLength(1);
  });

  it('marks the purchase failed and grants nothing when the intent does not succeed', async () => {
    const user = await aBuyer();

    stripe.answerNextPaymentWith(PAYMENT_STATUSES.requiresPaymentMethod);

    const view = await purchases.purchase(user.id, { packageCode: SMALL });

    await webhook.ingest(
      aPaymentEvent(
        WEBHOOK_EVENT_TYPES.paymentIntentPaymentFailed,
        await intentOf(view.purchaseId),
      ),
    );

    expect((await purchaseRow(view.purchaseId)).status).toBe(PaymentStatus.FAILED);
    expect((await walletOf(user)).addonCredits).toBe(0);
    expect(await allocationsFor(user)).toHaveLength(0);
  });

  it('refuses a frozen wallet before Stripe is called', async () => {
    const user = await aBuyer(WalletStatus.FROZEN);
    const intentsBefore = stripe.paymentCount;

    await expect(purchases.purchase(user.id, { packageCode: SMALL })).rejects.toMatchObject({
      code: 'WALLET_FROZEN',
    });

    expect(stripe.paymentCount).toBe(intentsBefore);
    expect(await prisma.paymentTransaction.count({ where: { userId: user.id } })).toBe(0);
    expect((await walletOf(user)).addonCredits).toBe(0);
  });

  it('lands both grants when the same package is bought twice', async () => {
    const user = await aBuyer();
    const first = await purchases.purchase(user.id, { packageCode: SMALL });
    const second = await purchases.purchase(user.id, { packageCode: SMALL });

    await webhook.ingest(
      aPaymentEvent(WEBHOOK_EVENT_TYPES.paymentIntentSucceeded, await intentOf(first.purchaseId)),
    );
    await webhook.ingest(
      aPaymentEvent(WEBHOOK_EVENT_TYPES.paymentIntentSucceeded, await intentOf(second.purchaseId)),
    );

    expect((await walletOf(user)).addonCredits).toBe(first.credits + second.credits);
    expect(await allocationsFor(user)).toHaveLength(2);
  });
});
