import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { ConfigModule } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, configureApp } from '../../src/app.setup';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { STRIPE_WEBHOOK_PATH } from '../../src/common/constants';
import { AddonsService } from '../../src/addons/addons.service';
import { CreditRepository } from '../../src/credits/credit.repository';
import { CheckoutCompletedHandler } from '../../src/webhooks/handlers/checkout-completed.handler';
import { CreditsService } from '../../src/credits/credits.service';
import { subscriptionAllocationKey } from '../../src/credits/idempotency-key';
import { CustomersService } from '../../src/customers/customers.service';
import {
  BillingInterval,
  CreditGrantSource,
  CreditTransactionType,
  PaymentStatus,
  SubscriptionStatus,
} from '../../src/generated/prisma/enums';
import type { SubscriptionModel } from '../../src/generated/prisma/models';
import { PaymentMethodsService } from '../../src/payment-methods/payment-methods.service';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import type { ProviderInvoice } from '../../src/provider/billing-provider';
import {
  FakeBillingProvider,
  FakeDelivery,
} from '../../src/provider/testing/fake-billing.provider';
import { ProvisioningService } from '../../src/subscriptions/provisioning.service';
import { SubscriptionLifecycleService } from '../../src/subscriptions/subscription-lifecycle.service';
import { SubscriptionLookupService } from '../../src/subscriptions/subscription-lookup.service';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository';
import { toEntitlementState } from '../../src/subscriptions/subscription-status';
import { InvoicePaidHandler } from '../../src/webhooks/handlers/invoice-paid.handler';
import { InvoicePaymentFailedHandler } from '../../src/webhooks/handlers/invoice-payment-failed.handler';
import { PaymentMethodHandler } from '../../src/webhooks/handlers/payment-method.handler';
import { SubscriptionEndedHandler } from '../../src/webhooks/handlers/subscription-ended.handler';
import { SubscriptionUpdatedHandler } from '../../src/webhooks/handlers/subscription-updated.handler';
import { WebhookService } from '../../src/webhooks/webhook.service';
import { testDatabase } from './test-database';

/**
 * Webhook processing and dunning, asserted against
 * `specs/webhook-processing/spec.md` and the grace-period requirements of
 * `specs/subscription-lifecycle/spec.md`. Scenario names are verbatim.
 */

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

const CHECKOUT_URLS = {
  successUrl: 'https://test.local/success',
  cancelUrl: 'https://test.local/cancel',
};

describe('webhooks and dunning', () => {
  let moduleRef: TestingModule;
  let webhooks: WebhookService;
  let provisioning: ProvisioningService;
  let lifecycle: SubscriptionLifecycleService;
  let credits: CreditsService;
  let provider: FakeBillingProvider;
  let productId: string;
  let userId: string;

  beforeAll(async () => {
    provider = new FakeBillingProvider();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        CatalogModule,
      ],
      providers: [
        WebhookService,
        InvoicePaidHandler,
        InvoicePaymentFailedHandler,
        CheckoutCompletedHandler,
        AddonsService,
        SubscriptionUpdatedHandler,
        SubscriptionEndedHandler,
        CreditRepository,
        CreditsService,
        CustomersService,
        PaymentsService,
        PaymentMethodsService,
        PaymentMethodHandler,
        ProvisioningService,
        SubscriptionLifecycleService,
        SubscriptionLookupService,
        SubscriptionRepository,
        { provide: BILLING_PROVIDER, useValue: provider },
      ],
    }).compile();
    await moduleRef.init();

    webhooks = moduleRef.get(WebhookService);
    provisioning = moduleRef.get(ProvisioningService);
    lifecycle = moduleRef.get(SubscriptionLifecycleService);
    credits = moduleRef.get(CreditsService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    provider.reset();
    provider.priceIntervals.set(PRICE_IDS.STRIPE_PRICE_AI_PRO_ANNUAL, 'year');

    const seeded = await seedCatalog(testDatabase.prisma, PRICE_IDS);
    productId = seeded.productId;
    userId = await newUser();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function newUser(): Promise<string> {
    const user = await testDatabase.prisma.user.create({
      data: { email: `${randomUUID()}@test.local` },
    });
    return user.id;
  }

  function provisionFree(forUser = userId): Promise<SubscriptionModel> {
    return provisioning.provisionFreeSubscription(forUser, productId);
  }

  /** Starts a Pro checkout and lets the provider complete the payment. */
  async function payForPro(
    forUser = userId,
    billingInterval: BillingInterval = BillingInterval.MONTH,
  ): Promise<string> {
    const checkout = await lifecycle.createProCheckout({
      userId: forUser,
      productId,
      billingInterval,
      ...CHECKOUT_URLS,
    });
    return provider.completeCheckout(checkout.checkoutSessionId).id;
  }

  function deliverInvoicePaid(
    providerSubscriptionId: string,
    overrides: Partial<ProviderInvoice> = {},
  ): FakeDelivery {
    return provider.deliver('invoice.paid', {
      kind: 'invoice-paid',
      invoice: provider.invoiceFor(providerSubscriptionId, {
        amountPaid: 2000,
        amountDue: 2000,
        ...overrides,
      }),
    });
  }

  function deliverPaymentFailed(
    providerSubscriptionId: string,
    overrides: Partial<ProviderInvoice> = {},
  ): FakeDelivery {
    return provider.deliver('invoice.payment_failed', {
      kind: 'invoice-payment-failed',
      invoice: provider.invoiceFor(providerSubscriptionId, {
        amountPaid: 0,
        amountDue: 2000,
        failureReason: 'card_declined',
        ...overrides,
      }),
    });
  }

  function deliverSubscriptionDeleted(
    providerSubscriptionId: string,
  ): FakeDelivery {
    const atProvider = provider.subscriptions.get(providerSubscriptionId)!;
    return provider.deliver('customer.subscription.deleted', {
      kind: 'subscription-ended',
      subscription: { ...atProvider, status: SubscriptionStatus.CANCELED },
    });
  }

  function receive(delivery: FakeDelivery) {
    return webhooks.receive(delivery.payload, delivery.signature);
  }

  /** Free, then Pro paid for and its first invoice delivered. */
  async function upgradedToPro(forUser = userId): Promise<SubscriptionModel> {
    await provisionFree(forUser);
    const providerSubscriptionId = await payForPro(forUser);
    await receive(deliverInvoicePaid(providerSubscriptionId));

    return testDatabase.prisma.subscription.findUniqueOrThrow({
      where: { providerSubscriptionId },
    });
  }

  function liveSubscriptions(forUser = userId) {
    return testDatabase.prisma.subscription.findMany({
      where: {
        userId: forUser,
        productId,
        status: {
          in: [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.TRIALING,
            SubscriptionStatus.PAST_DUE,
          ],
        },
      },
      include: { plan: { select: { key: true, isPaid: true } } },
    });
  }

  async function balance(forUser = userId) {
    const live = await liveSubscriptions(forUser);
    return credits.getBalance(
      forUser,
      productId,
      toEntitlementState(
        live.length === 1
          ? { status: live[0].status, isPaidPlan: live[0].plan.isPaid }
          : null,
      ),
    );
  }

  // ==========================================================================
  describe('Requirement: Webhook Signature Verification', () => {
    it('Valid signature is accepted', async () => {
      await provisionFree();
      const delivery = provider.deliver('customer.discount.created', null);

      const receipt = await receive(delivery);

      expect(receipt.outcome).toBe('unhandled');
      expect(receipt.eventId).toMatch(/^evt_/);
    });

    it('Unsigned or tampered payload', async () => {
      const subscription = await provisionFree();
      const delivery = deliverInvoicePaid(
        subscription.providerSubscriptionId,
        {},
      );

      await expect(
        webhooks.receive(delivery.payload, 'not-the-signature'),
      ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });

      // Nothing was recorded and nothing was granted.
      expect(await testDatabase.prisma.webhookEvent.count()).toBe(0);
      expect(await testDatabase.prisma.creditGrant.count()).toBe(0);
    });

    it('Raw body is preserved', async () => {
      const subscription = await provisionFree();
      const delivery = deliverInvoicePaid(subscription.providerSubscriptionId);

      // The same event re-serialised — semantically identical, byte-different.
      const reserialised = Buffer.from(
        JSON.stringify(
          JSON.parse(delivery.payload.toString('utf8')) as Record<
            string,
            unknown
          >,
          null,
          2,
        ),
      );

      await expect(
        webhooks.receive(reserialised, delivery.signature),
      ).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    });
  });

  // ==========================================================================
  describe('Requirement: Event Processing Is Idempotent', () => {
    it('Duplicate delivery of the same event', async () => {
      const subscription = await provisionFree();
      const delivery = deliverInvoicePaid(subscription.providerSubscriptionId, {
        amountPaid: 0,
        amountDue: 0,
      });

      const first = await receive(delivery);
      const second = await receive(provider.redeliver(delivery));

      expect(first.outcome).toBe('processed');
      expect(second.outcome).toBe('duplicate');
      expect(await testDatabase.prisma.creditGrant.count()).toBe(1);
      expect(await testDatabase.prisma.payment.count()).toBe(1);
      expect(await testDatabase.prisma.webhookEvent.count()).toBe(1);
      expect((await balance()).spendable).toBe(50);
    });

    it('Concurrent delivery to two instances', async () => {
      const subscription = await provisionFree();
      const delivery = deliverInvoicePaid(subscription.providerSubscriptionId, {
        amountPaid: 0,
        amountDue: 0,
      });

      const outcomes = await Promise.allSettled([
        receive(delivery),
        receive(provider.redeliver(delivery)),
      ]);

      // Whatever each caller was told, exactly one set of effects exists.
      expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
      expect(await testDatabase.prisma.creditGrant.count()).toBe(1);
      expect(await testDatabase.prisma.payment.count()).toBe(1);
      expect(await testDatabase.prisma.webhookEvent.count()).toBe(1);
      expect((await balance()).spendable).toBe(50);
    });

    it('Idempotency is enforced by the database', async () => {
      const delivery = provider.deliver('customer.discount.created', null);
      await receive(delivery);

      const recorded =
        await testDatabase.prisma.webhookEvent.findFirstOrThrow();
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO webhook_events (provider_event_id, type, payload)
           VALUES ($1, $2, '{}'::jsonb)`,
          [recorded.providerEventId, recorded.type],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('Crash mid-processing leaves no partial effect', async () => {
      const pro = await upgradedToPro();
      const nextPeriodStart = pro.nextCreditResetAt!;

      // Block the allocation the way a crash would: the period's ledger claim is
      // already taken, so the handler's transaction cannot commit.
      const blocker = await testDatabase.prisma.creditGrant.create({
        data: {
          userId,
          productId,
          source: CreditGrantSource.ADJUSTMENT,
          amountInitial: 0,
          amountRemaining: 0,
          priority: 1,
          transactions: {
            create: {
              operationId: randomUUID(),
              idempotencyKey: subscriptionAllocationKey(
                pro.id,
                nextPeriodStart,
              ),
              type: CreditTransactionType.ADJUSTMENT,
              amount: 0,
              grantAmountRemainingAfter: 0,
            },
          },
        },
      });

      const renewal = deliverInvoicePaid(pro.providerSubscriptionId, {
        periodStart: nextPeriodStart,
        attemptCount: 1,
      });
      const paymentsBefore = await testDatabase.prisma.payment.count();

      await expect(receive(renewal)).rejects.toThrow();

      // The payment record was written in the same transaction as the grant, so
      // neither survives — no observable state has only some of the effects.
      expect(await testDatabase.prisma.payment.count()).toBe(paymentsBefore);
      const unsettled = await testDatabase.prisma.webhookEvent.findFirstOrThrow(
        { where: { providerEventId: renewal.eventId } },
      );
      expect(unsettled.processedAt).toBeNull();

      // Redelivery completes it exactly once.
      await testDatabase.prisma.creditTransaction.deleteMany({
        where: { creditGrantId: blocker.id },
      });
      await testDatabase.prisma.creditGrant.delete({
        where: { id: blocker.id },
      });

      const receipt = await receive(provider.redeliver(renewal));

      expect(receipt.outcome).toBe('processed');
      expect(await testDatabase.prisma.payment.count()).toBe(
        paymentsBefore + 1,
      );
      const grants = await testDatabase.prisma.creditGrant.findMany({
        where: { subscriptionId: pro.id },
      });
      expect(grants).toHaveLength(2);
    });
  });

  // ==========================================================================
  describe('Requirement: Unknown Provider Subscription Is Ignored', () => {
    it('Update arrives for an unknown subscription', async () => {
      await provisionFree();
      const stranger = await payForPro(await newUser());
      await testDatabase.prisma.subscription.deleteMany({
        where: { providerSubscriptionId: stranger },
      });

      const receipt = await receive(
        provider.deliver('customer.subscription.updated', {
          kind: 'subscription-updated',
          subscription: provider.subscriptions.get(stranger)!,
        }),
      );

      expect(receipt.outcome).toBe('ignored');
      expect(
        await testDatabase.prisma.subscription.count({
          where: { providerSubscriptionId: stranger },
        }),
      ).toBe(0);
      // Recorded for diagnosis rather than raised as an error.
      expect(
        (
          await testDatabase.prisma.webhookEvent.findFirstOrThrow({
            where: { providerEventId: receipt.eventId },
          })
        ).processedAt,
      ).not.toBeNull();
    });

    it('Out-of-order delivery', async () => {
      await provisionFree();
      const providerSubscriptionId = await payForPro();

      // The update arrives before the invoice that creates the row.
      const early = await receive(
        provider.deliver('customer.subscription.updated', {
          kind: 'subscription-updated',
          subscription: provider.subscriptions.get(providerSubscriptionId)!,
        }),
      );
      expect(early.outcome).toBe('ignored');

      const late = await receive(
        deliverInvoicePaid(providerSubscriptionId, { amountPaid: 2000 }),
      );

      expect(late.outcome).toBe('processed');
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].plan.isPaid).toBe(true);
      expect((await balance()).spendable).toBe(100);
    });
  });

  // ==========================================================================
  describe('Requirement: Superseded Free Subscription Deletion Creates No New Row', () => {
    it('Deletion of a superseded free subscription', async () => {
      const free = await provisionFree();
      const pro = await upgradedToPro();
      const subscriptionsBefore = await testDatabase.prisma.subscription.count({
        where: { userId },
      });

      const receipt = await receive(
        deliverSubscriptionDeleted(free.providerSubscriptionId),
      );

      expect(receipt.outcome).toBe('ignored');
      expect(
        await testDatabase.prisma.subscription.count({ where: { userId } }),
      ).toBe(subscriptionsBefore);
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(pro.id);
    });

    it('Deletion with no live subscription remaining', async () => {
      const free = await provisionFree();

      const receipt = await receive(
        deliverSubscriptionDeleted(free.providerSubscriptionId),
      );

      expect(receipt.outcome).toBe('processed');
      const rows = await testDatabase.prisma.subscription.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0].status).toBe(SubscriptionStatus.CANCELED);
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].plan.isPaid).toBe(false);
      expect(live[0].id).not.toBe(free.id);
    });
  });

  // ==========================================================================
  describe('Requirement: Zombie Subscriptions Do Not Revive Terminal Rows', () => {
    it('A zombie free subscription renews', async () => {
      const free = await provisionFree();
      const pro = await upgradedToPro();
      const balanceBefore = await balance();

      // The Free Stripe subscription was never cancelled and bills again.
      const receipt = await receive(
        deliverInvoicePaid(free.providerSubscriptionId, {
          amountPaid: 0,
          amountDue: 0,
        }),
      );

      expect(receipt.outcome).toBe('ignored');
      expect((await reload(free.id)).status).toBe(SubscriptionStatus.CANCELED);
      expect(
        await testDatabase.prisma.creditGrant.count({
          where: { subscriptionId: free.id },
        }),
      ).toBe(0);
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(pro.id);
      expect(await balance()).toEqual(balanceBefore);
    });

    it('Live-only lookup in the paid invoice handler', async () => {
      const pro = await upgradedToPro();
      await lifecycle.cancelImmediately(pro.id);

      // An invoice arriving for the now-terminal paid subscription.
      const receipt = await receive(
        deliverInvoicePaid(pro.providerSubscriptionId),
      );

      expect(receipt.outcome).toBe('ignored');
      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
      const grants = await testDatabase.prisma.creditGrant.findMany({
        where: { subscriptionId: pro.id },
      });
      expect(grants.every((g) => g.amountRemaining === 0)).toBe(true);
    });
  });

  // ==========================================================================
  describe('Requirement: Handled Events Are Explicit', () => {
    it('Unhandled event type', async () => {
      await upgradedToPro();
      const before = await snapshot();

      const receipt = await receive(
        provider.deliver('customer.discount.created', null),
      );

      expect(receipt.outcome).toBe('unhandled');
      expect(await snapshot()).toEqual(before);
      const recorded = await testDatabase.prisma.webhookEvent.findFirstOrThrow({
        where: { providerEventId: receipt.eventId },
      });
      expect(recorded.type).toBe('customer.discount.created');
      expect(recorded.processedAt).not.toBeNull();
    });

    it('Payment failure event is handled', async () => {
      const pro = await upgradedToPro();

      const receipt = await receive(
        deliverPaymentFailed(pro.providerSubscriptionId, { attemptCount: 1 }),
      );

      expect(receipt.outcome).toBe('processed');
      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.PAST_DUE);
      const failures = await testDatabase.prisma.payment.findMany({
        where: { subscriptionId: pro.id, status: PaymentStatus.FAILED },
      });
      expect(failures).toHaveLength(1);
      expect(failures[0].failureReason).toBe('card_declined');
    });
  });

  // ==========================================================================
  describe('Requirement: Payment Failure Grace Period', () => {
    it('Renewal payment fails', async () => {
      const pro = await upgradedToPro();
      const grantsBefore = await testDatabase.prisma.creditGrant.findMany({
        where: { subscriptionId: pro.id },
      });

      await receive(deliverPaymentFailed(pro.providerSubscriptionId));

      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.PAST_DUE);
      expect(
        await testDatabase.prisma.payment.count({
          where: { subscriptionId: pro.id, status: PaymentStatus.FAILED },
        }),
      ).toBe(1);
      // Nothing granted, nothing lost — only frozen.
      expect(
        await testDatabase.prisma.creditGrant.findMany({
          where: { subscriptionId: pro.id },
        }),
      ).toEqual(grantsBefore);
      const frozen = await balance();
      expect(frozen).toMatchObject({ spendable: 0, frozen: 100 });
      expect(frozen.freezeReason).toBe('PAST_DUE');
    });

    it('Retry state is observable locally', async () => {
      const pro = await upgradedToPro();
      const nextAttempt = new Date(Date.now() + 86_400_000);

      await receive(
        deliverPaymentFailed(pro.providerSubscriptionId, { attemptCount: 1 }),
      );
      await receive(
        deliverPaymentFailed(pro.providerSubscriptionId, {
          attemptCount: 2,
          nextPaymentAttemptAt: nextAttempt,
        }),
      );

      const row = await reload(pro.id);
      expect(row.paymentAttemptCount).toBe(2);
      expect(row.nextPaymentAttemptAt).toEqual(nextAttempt);
      // Each attempt left its own record.
      expect(
        await testDatabase.prisma.payment.count({
          where: { subscriptionId: pro.id, status: PaymentStatus.FAILED },
        }),
      ).toBe(2);
    });

    it('Card is fixed during the grace period', async () => {
      const pro = await upgradedToPro();
      await receive(
        deliverPaymentFailed(pro.providerSubscriptionId, { attemptCount: 1 }),
      );
      expect((await balance()).spendable).toBe(0);

      // The retry succeeds before Stripe gives up.
      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: pro.planId },
      });
      await receive(
        deliverInvoicePaid(pro.providerSubscriptionId, {
          periodStart: pro.nextCreditResetAt,
          attemptCount: 2,
        }),
      );

      const row = await reload(pro.id);
      expect(row.status).toBe(SubscriptionStatus.ACTIVE);
      expect(row.paymentAttemptCount).toBe(0);
      // Previously frozen credit is spendable again immediately — the new
      // period's grant, the old one having expired at the boundary.
      expect((await balance()).spendable).toBe(plan.creditsPerPeriod);
    });

    it('Local state does not pre-empt Stripe', async () => {
      const pro = await upgradedToPro();

      for (const attemptCount of [1, 2, 3]) {
        await receive(
          deliverPaymentFailed(pro.providerSubscriptionId, { attemptCount }),
        );
      }

      // Three attempts and more than three days later, with no cancellation
      // event, the subscription is still not terminal.
      const row = await reload(pro.id);
      expect(row.status).toBe(SubscriptionStatus.PAST_DUE);
      expect(row.paymentAttemptCount).toBe(3);
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(pro.id);
    });

    it('Grace period is exhausted', async () => {
      const pro = await upgradedToPro();
      const addonPackage =
        await testDatabase.prisma.addonPackage.findFirstOrThrow({
          where: { productId },
        });
      const purchase = await testDatabase.prisma.addonPurchase.create({
        data: { userId, productId, addonPackageId: addonPackage.id },
      });
      await credits.grantAddonCredits({
        userId,
        productId,
        addonPurchaseId: purchase.id,
        amount: 40,
      });

      await receive(deliverPaymentFailed(pro.providerSubscriptionId));
      const duringDunning = await balance();
      expect(duringDunning).toMatchObject({ spendable: 0, frozen: 140 });

      // Stripe gives up and cancels.
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);
      const receipt = await receive(
        deliverSubscriptionDeleted(pro.providerSubscriptionId),
      );

      expect(receipt.outcome).toBe('processed');
      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].plan.isPaid).toBe(false);

      // Pro credits expired; the add-on balance moved from frozen-by-past-due to
      // frozen-by-being-on-Free, unchanged throughout.
      const onFree = await balance();
      expect(onFree).toMatchObject({ spendable: 0, frozen: 40 });

      // And the Free plan's own credits arrive with its $0 invoice.
      const freeRow = live[0];
      await receive(
        deliverInvoicePaid(freeRow.providerSubscriptionId, {
          amountPaid: 0,
          amountDue: 0,
        }),
      );
      expect((await balance()).spendable).toBe(50);
    });
  });

  // -------------------------------------------------------------------------

  function reload(subscriptionId: string): Promise<SubscriptionModel> {
    return testDatabase.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
  }

  async function snapshot() {
    return {
      subscriptions: await testDatabase.prisma.subscription.count(),
      grants: await testDatabase.prisma.creditGrant.count(),
      ledger: await testDatabase.prisma.creditTransaction.count(),
      payments: await testDatabase.prisma.payment.count(),
    };
  }
});

// ===========================================================================
// The endpoint itself, over HTTP, because the bug signature verification guards
// against lives in the plumbing between Express and the verifier.
// ===========================================================================
describe('the webhook endpoint', () => {
  let app: INestApplication;
  let provider: FakeBillingProvider;

  // Nest types `getHttpServer()` as `any`. Naming the return type here keeps
  // that `any` from flowing into every `request(...)` call below.
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    provider = new FakeBillingProvider();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BILLING_PROVIDER)
      .useValue(provider)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    configureApp(app as NestExpressApplication);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    provider.reset();
  });

  it('No caller credentials required', async () => {
    const delivery = provider.deliver('customer.discount.created', null);

    const response = await request(server())
      .post(STRIPE_WEBHOOK_PATH)
      .set('stripe-signature', delivery.signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: 'unhandled' });
  });

  it('Endpoint acknowledges promptly', async () => {
    const delivery = provider.deliver('customer.discount.created', null);
    const startedAt = Date.now();

    await request(server())
      .post(STRIPE_WEBHOOK_PATH)
      .set('stripe-signature', delivery.signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'))
      .expect(200);

    // Stripe's delivery timeout is 20 seconds; this asserts the endpoint is not
    // blocking on downstream work at all.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('rejects an unsigned delivery with the standard error shape', async () => {
    const delivery = provider.deliver('customer.discount.created', null);

    const response = await request(server())
      .post(STRIPE_WEBHOOK_PATH)
      .set('stripe-signature', 'nonsense')
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:\d+/);
  });
});
