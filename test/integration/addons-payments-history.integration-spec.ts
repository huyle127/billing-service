import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AddonsService } from '../../src/addons/addons.service';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { creditPolicyOf } from '../../src/catalog/credit-policy';
import { creditPeriodFrom } from '../../src/credits/credit-period';
import { CreditHistoryService } from '../../src/credits/credit-history.service';
import { CreditRepository } from '../../src/credits/credit.repository';
import { CreditsService } from '../../src/credits/credits.service';
import { CustomersService } from '../../src/customers/customers.service';
import {
  AddonPurchaseStatus,
  BillingInterval,
  CreditGrantSource,
  CreditTransactionType,
  PaymentStatus,
  PaymentType,
  SubscriptionStatus,
} from '../../src/generated/prisma/enums';
import type { SubscriptionModel } from '../../src/generated/prisma/models';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import { FakeBillingProvider } from '../../src/provider/testing/fake-billing.provider';
import { BillingStateService } from '../../src/subscriptions/billing-state.service';
import { ProvisioningService } from '../../src/subscriptions/provisioning.service';
import { SubscriptionHistoryService } from '../../src/subscriptions/subscription-history.service';
import { SubscriptionLifecycleService } from '../../src/subscriptions/subscription-lifecycle.service';
import { SubscriptionLookupService } from '../../src/subscriptions/subscription-lookup.service';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository';
import { testDatabase } from './test-database';

/**
 * Add-on purchase, payment recording, and the history and billing-state reads —
 * asserted against `specs/addon-purchase` and `specs/billing-history`, with
 * scenario names used verbatim.
 *
 * Two requirements of `billing-history` are not here: *API Errors Are
 * Standardised* and *Implemented Endpoints Are Documented* are properties of the
 * HTTP surface, and belong to the phase that builds it.
 */

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

const CHECKOUT_URLS = {
  successUrl: 'https://test.local/success',
  cancelUrl: 'https://test.local/cancel',
};

describe('add-ons, payments, and history', () => {
  let moduleRef: TestingModule;
  let provisioning: ProvisioningService;
  let lifecycle: SubscriptionLifecycleService;
  let addons: AddonsService;
  let payments: PaymentsService;
  let credits: CreditsService;
  let creditHistory: CreditHistoryService;
  let subscriptionHistory: SubscriptionHistoryService;
  let billingState: BillingStateService;
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
        AddonsService,
        BillingStateService,
        CreditHistoryService,
        CreditRepository,
        CreditsService,
        CustomersService,
        PaymentsService,
        ProvisioningService,
        SubscriptionHistoryService,
        SubscriptionLifecycleService,
        SubscriptionLookupService,
        SubscriptionRepository,
        { provide: BILLING_PROVIDER, useValue: provider },
      ],
    }).compile();
    await moduleRef.init();

    provisioning = moduleRef.get(ProvisioningService);
    lifecycle = moduleRef.get(SubscriptionLifecycleService);
    addons = moduleRef.get(AddonsService);
    payments = moduleRef.get(PaymentsService);
    credits = moduleRef.get(CreditsService);
    creditHistory = moduleRef.get(CreditHistoryService);
    subscriptionHistory = moduleRef.get(SubscriptionHistoryService);
    billingState = moduleRef.get(BillingStateService);
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

  async function freeThenPro(
    forUser = userId,
    billingInterval: BillingInterval = BillingInterval.MONTH,
    relatedEvent?: { type: string; id: string },
  ): Promise<SubscriptionModel> {
    await provisioning.provisionFreeSubscription(forUser, productId);
    const checkout = await lifecycle.createProCheckout({
      userId: forUser,
      productId,
      billingInterval,
      ...CHECKOUT_URLS,
    });
    const paid = provider.completeCheckout(checkout.checkoutSessionId);

    return lifecycle.transitionFreeToPro({
      userId: forUser,
      productId,
      providerSubscriptionId: paid.id,
      relatedEvent,
    });
  }

  /** Buys an add-on end to end, as the provider's confirmation would. */
  async function buyAddon(
    addonPackageKey = 'credits-100',
    amountPaid = 1000,
    paymentIntentId = `pi_${randomUUID()}`,
  ) {
    const checkout = await addons.initiatePurchase({
      userId,
      productId,
      addonPackageKey,
      ...CHECKOUT_URLS,
    });

    const fulfilment = await addons.fulfilPurchase({
      providerCheckoutSessionId: checkout.checkoutSessionId,
      providerPaymentIntentId: paymentIntentId,
      amount: amountPaid,
      currency: 'usd',
    });

    return { checkout, fulfilment };
  }

  async function allocateFirstCreditPeriod(
    subscription: SubscriptionModel,
    relatedEvent?: { type: string; id: string },
  ): Promise<void> {
    const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
      where: { id: subscription.planId },
    });
    const policy = creditPolicyOf(plan);
    const period = creditPeriodFrom(subscription.currentPeriodStart!, policy);

    await credits.allocateSubscriptionCredits({
      userId: subscription.userId,
      productId: subscription.productId,
      subscriptionId: subscription.id,
      creditPeriodStart: period.start,
      creditPeriodEnd: period.end,
      amount: policy.creditsPerPeriod,
      relatedEvent,
    });
  }

  function state() {
    return billingState.getBillingState(userId, productId);
  }

  // ==========================================================================
  describe('Requirement: Add-On Purchase Requires A Live Paid Subscription', () => {
    it('Free user attempts an add-on purchase', async () => {
      await provisioning.provisionFreeSubscription(userId, productId);
      const providerCallsBefore = provider.calls.length;

      await expect(
        addons.initiatePurchase({
          userId,
          productId,
          addonPackageKey: 'credits-100',
          ...CHECKOUT_URLS,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBSCRIPTION_STATE' });

      expect(provider.calls.length).toBe(providerCallsBefore);
      expect(provider.checkoutSessions.size).toBe(0);
      expect(await testDatabase.prisma.addonPurchase.count()).toBe(0);
      expect(await testDatabase.prisma.payment.count()).toBe(0);
      expect(
        await testDatabase.prisma.creditGrant.count({
          where: { source: CreditGrantSource.ADDON },
        }),
      ).toBe(0);
      expect(await testDatabase.prisma.creditTransaction.count()).toBe(0);
    });

    it('Pro user is eligible', async () => {
      await freeThenPro();

      const checkout = await addons.initiatePurchase({
        userId,
        productId,
        addonPackageKey: 'credits-100',
        ...CHECKOUT_URLS,
      });

      expect(checkout.url).toBeTruthy();
      expect(checkout.creditAmount).toBe(100);
      const purchase =
        await testDatabase.prisma.addonPurchase.findUniqueOrThrow({
          where: { id: checkout.addonPurchaseId },
        });
      expect(purchase.status).toBe(AddonPurchaseStatus.PENDING);
    });

    it('Eligibility is checked before Stripe is called', async () => {
      // A user with no subscription at all: the check must fail before the
      // provider is reached, so not even a customer is created.
      const stranger = await newUser();

      await expect(
        addons.initiatePurchase({
          userId: stranger,
          productId,
          addonPackageKey: 'credits-100',
          ...CHECKOUT_URLS,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBSCRIPTION_STATE' });

      expect(provider.calls).toEqual([]);
    });

    it('No user can buy credit that is unspendable on arrival', async () => {
      const pro = await freeThenPro();

      const { fulfilment } = await buyAddon('credits-100');

      // The buyer held a live paid subscription throughout, so the freeze rule
      // leaves the new grant spendable the moment it exists.
      const after = await state();
      expect(after.subscription!.id).toBe(pro.id);
      expect(after.subscription!.isPaidPlan).toBe(true);
      expect(after.credits.frozen).toBe(0);
      // Pro's 100 for the period, plus the add-on's 100, all spendable.
      expect(after.credits.spendable).toBe(200);
      expect(fulfilment.grant.amountRemaining).toBe(100);
    });
  });

  // ==========================================================================
  describe('Requirement: Add-On Purchase Is A One-Time Payment', () => {
    it('Add-on purchase leaves subscriptions untouched', async () => {
      const pro = await freeThenPro();
      const before = await testDatabase.prisma.subscription.findMany({
        where: { userId, productId },
        orderBy: { createdAt: 'asc' },
      });

      await buyAddon();

      const after = await testDatabase.prisma.subscription.findMany({
        where: { userId, productId },
        orderBy: { createdAt: 'asc' },
      });
      expect(after).toEqual(before);
      expect(after.find((s) => s.id === pro.id)!.providerSubscriptionId).toBe(
        pro.providerSubscriptionId,
      );
    });

    it('Add-on is not treated as recurring', async () => {
      await freeThenPro();
      const subscriptionsCreated =
        provider.callsTo('createSubscription').length;

      await buyAddon();

      expect(provider.callsTo('createSubscription')).toHaveLength(
        subscriptionsCreated,
      );
      const session = provider.callsTo('createCheckoutSession').at(-1) as {
        mode: string;
        priceId: string;
      };
      expect(session.mode).toBe('payment');
      const addonPackage =
        await testDatabase.prisma.addonPackage.findUniqueOrThrow({
          where: { stripePriceId: session.priceId },
        });
      expect(addonPackage.key).toBe('credits-100');
    });
  });

  // ==========================================================================
  describe('Requirement: Add-On Credits Are Granted Only After Successful Payment', () => {
    it('Successful add-on payment', async () => {
      await freeThenPro();

      const { fulfilment } = await buyAddon('credits-500', 4000);

      expect(fulfilment.grant.source).toBe(CreditGrantSource.ADDON);
      expect(fulfilment.grant.amountRemaining).toBe(500);
      expect(fulfilment.purchase.status).toBe(AddonPurchaseStatus.COMPLETED);

      const history = await payments.listPaymentHistory(userId, { productId });
      expect(history).toHaveLength(1);
      expect(history[0].type).toBe(PaymentType.ADDON_ONE_TIME);
      expect(history[0].status).toBe(PaymentStatus.SUCCEEDED);

      const ledger = await testDatabase.prisma.creditTransaction.findMany({
        where: { creditGrantId: fulfilment.grant.id },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].type).toBe(CreditTransactionType.ALLOCATION);
      expect(ledger[0].amount).toBe(500);
    });

    it('Abandoned add-on purchase', async () => {
      await freeThenPro();

      await addons.initiatePurchase({
        userId,
        productId,
        addonPackageKey: 'credits-100',
        ...CHECKOUT_URLS,
      });

      // Stripe never confirms payment.
      expect(
        await testDatabase.prisma.creditGrant.count({
          where: { source: CreditGrantSource.ADDON },
        }),
      ).toBe(0);
      expect(await testDatabase.prisma.payment.count()).toBe(0);
      const purchase = await testDatabase.prisma.addonPurchase.findFirstOrThrow(
        { where: { userId } },
      );
      expect(purchase.status).toBe(AddonPurchaseStatus.PENDING);
    });

    it('Duplicate add-on payment event', async () => {
      await freeThenPro();
      const paymentIntentId = `pi_${randomUUID()}`;
      const { checkout, fulfilment } = await buyAddon(
        'credits-100',
        1000,
        paymentIntentId,
      );

      const replay = await addons.fulfilPurchase({
        providerCheckoutSessionId: checkout.checkoutSessionId,
        providerPaymentIntentId: paymentIntentId,
        amount: 1000,
        currency: 'usd',
      });

      expect(replay.created).toBe(false);
      expect(replay.grant.id).toBe(fulfilment.grant.id);
      expect(replay.payment.id).toBe(fulfilment.payment.id);
      expect(
        await testDatabase.prisma.creditGrant.count({
          where: { source: CreditGrantSource.ADDON },
        }),
      ).toBe(1);
      expect(await testDatabase.prisma.payment.count()).toBe(1);
      expect((await state()).credits.spendable).toBe(200);
    });

    it('Grant amount comes from the SKU', async () => {
      await freeThenPro();

      // The amount paid is deliberately nothing like the SKU's credit amount.
      const { fulfilment } = await buyAddon('credits-500', 7);

      expect(fulfilment.grant.amountInitial).toBe(500);
      expect(fulfilment.payment.amount).toBe(7);
    });
  });

  // ==========================================================================
  describe('Requirement: Add-On Grants Are Distinguishable From Subscription Grants', () => {
    it('Source is recorded', async () => {
      await freeThenPro();

      const { fulfilment } = await buyAddon();

      expect(fulfilment.grant.source).toBe(CreditGrantSource.ADDON);
      expect(fulfilment.grant.addonPurchaseId).toBe(fulfilment.purchase.id);
      expect(fulfilment.grant.subscriptionId).toBeNull();
      // Attributable to the payment that produced it, through that purchase.
      expect(fulfilment.payment.addonPurchaseId).toBe(fulfilment.purchase.id);
      expect(fulfilment.payment.subscriptionId).toBeNull();
    });

    it('Add-on grants survive subscription expiry', async () => {
      const pro = await freeThenPro();
      const { fulfilment } = await buyAddon();

      await lifecycle.cancelImmediately(pro.id);

      const addonGrant =
        await testDatabase.prisma.creditGrant.findUniqueOrThrow({
          where: { id: fulfilment.grant.id },
        });
      expect(addonGrant.amountRemaining).toBe(100);
      expect(addonGrant.expiresAt).toBeNull();
      // The subscription's own credit did expire.
      const subscriptionGrants = await testDatabase.prisma.creditGrant.findMany(
        {
          where: { subscriptionId: pro.id },
        },
      );
      expect(subscriptionGrants.map((g) => g.amountRemaining)).toEqual([0]);
      // Preserved, and unspendable on Free.
      const after = await state();
      expect(after.credits).toMatchObject({ spendable: 0, frozen: 100 });
    });
  });

  // ==========================================================================
  describe('Requirement: Subscription History Is Complete', () => {
    it('Upgrade history is readable', async () => {
      const pro = await freeThenPro();

      const history = await subscriptionHistory.listSubscriptionHistory(
        userId,
        productId,
      );

      expect(history).toHaveLength(2);
      expect(history[0].planKey).toBe('free');
      expect(history[0].status).toBe(SubscriptionStatus.CANCELED);
      expect(history[0].isLive).toBe(false);
      expect(history[1].planKey).toBe('pro');
      expect(history[1].id).toBe(pro.id);
      expect(history[1].isLive).toBe(true);

      for (const entry of history) {
        expect(entry.billingInterval).toBe(BillingInterval.MONTH);
        expect(entry.currentPeriodStart).toBeInstanceOf(Date);
        expect(entry.currentPeriodEnd).toBeInstanceOf(Date);
        expect(entry.providerSubscriptionId).toMatch(/^sub_/);
        expect(typeof entry.unitAmount).toBe('number');
      }
    });

    it('Rows are never deleted', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelImmediately(pro.id);

      const history = await subscriptionHistory.listSubscriptionHistory(
        userId,
        productId,
      );
      // Free, Pro, Free — the two terminal rows retained alongside the live one.
      expect(history).toHaveLength(3);
      expect(history.map((h) => h.isLive)).toEqual([false, false, true]);
      expect(history.find((h) => h.id === pro.id)!.status).toBe(
        SubscriptionStatus.CANCELED,
      );
    });

    it('Cycle change is traceable on one row', async () => {
      const pro = await freeThenPro();

      await lifecycle.changeCycle(pro.id, BillingInterval.YEAR);

      const history = await subscriptionHistory.listSubscriptionHistory(
        userId,
        productId,
      );
      expect(history).toHaveLength(2);
      const proEntry = history.find((h) => h.id === pro.id)!;
      expect(proEntry.billingInterval).toBe(BillingInterval.YEAR);
      expect(proEntry.providerSubscriptionId).toBe(pro.providerSubscriptionId);
    });
  });

  // ==========================================================================
  describe('Requirement: Payment History Is Complete', () => {
    it('Successful recurring payment', async () => {
      const pro = await freeThenPro();

      const { payment } = await payments.recordRecurringPayment({
        userId,
        subscriptionId: pro.id,
        amount: 2000,
        currency: 'usd',
        status: PaymentStatus.SUCCEEDED,
        providerInvoiceId: 'in_test_success',
        providerPaymentIntentId: 'pi_test_success',
        attemptNumber: 1,
      });

      expect(payment.type).toBe(PaymentType.SUBSCRIPTION_RECURRING);
      expect(payment.subscriptionId).toBe(pro.id);
      expect(payment.addonPurchaseId).toBeNull();
      expect(payment.providerInvoiceId).toBe('in_test_success');

      const history = await payments.listPaymentHistory(userId, { productId });
      expect(history.map((p) => p.id)).toEqual([payment.id]);
    });

    it('Failed payment is recorded', async () => {
      const pro = await freeThenPro();

      const { payment } = await payments.recordRecurringPayment({
        userId,
        subscriptionId: pro.id,
        amount: 2000,
        currency: 'usd',
        status: PaymentStatus.FAILED,
        providerInvoiceId: 'in_test_failed',
        attemptNumber: 1,
        failureReason: 'card_declined',
      });

      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.subscriptionId).toBe(pro.id);
      expect(payment.failureReason).toBe('card_declined');
    });

    it('records every attempt against one invoice', async () => {
      // Stripe retries an invoice up to three times, and each attempt is its own
      // record — which is why the identifier for a recurring payment is the pair
      // (invoice, attempt) rather than the invoice alone.
      const pro = await freeThenPro();
      const attempt = (attemptNumber: number, status: PaymentStatus) =>
        payments.recordRecurringPayment({
          userId,
          subscriptionId: pro.id,
          amount: 2000,
          currency: 'usd',
          status,
          providerInvoiceId: 'in_test_dunning',
          attemptNumber,
          providerPaymentIntentId: `pi_attempt_${attemptNumber}`,
        });

      const first = await attempt(1, PaymentStatus.FAILED);
      const second = await attempt(2, PaymentStatus.FAILED);
      const third = await attempt(3, PaymentStatus.SUCCEEDED);

      expect([first, second, third].map((r) => r.created)).toEqual([
        true,
        true,
        true,
      ]);
      expect(
        await testDatabase.prisma.payment.count({
          where: { providerInvoiceId: 'in_test_dunning' },
        }),
      ).toBe(3);
    });

    it('One-time add-on payment', async () => {
      await freeThenPro();

      const { fulfilment } = await buyAddon();

      expect(fulfilment.payment.type).toBe(PaymentType.ADDON_ONE_TIME);
      expect(fulfilment.payment.addonPurchaseId).toBe(fulfilment.purchase.id);
      expect(fulfilment.payment.subscriptionId).toBeNull();
    });

    it('No duplicate payment records', async () => {
      const pro = await freeThenPro();
      const input = {
        userId,
        subscriptionId: pro.id,
        amount: 2000,
        currency: 'usd',
        status: PaymentStatus.SUCCEEDED,
        providerInvoiceId: 'in_test_once',
        attemptNumber: 1,
      };

      const first = await payments.recordRecurringPayment(input);
      const again = await payments.recordRecurringPayment(input);

      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.payment.id).toBe(first.payment.id);
      expect(await testDatabase.prisma.payment.count()).toBe(1);

      // And the database refuses it too, not merely the service.
      const client = await testDatabase.newPgClient();
      await expect(
        client.query(
          `INSERT INTO payments
             (user_id, subscription_id, type, status, amount, currency,
              provider_invoice_id, attempt_number, updated_at)
           VALUES ($1::uuid, $2::uuid, 'SUBSCRIPTION_RECURRING', 'SUCCEEDED',
                   2000, 'usd', 'in_test_once', 1, now())`,
          [userId, pro.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('links a payment to a subscription or a purchase, never both', async () => {
      const pro = await freeThenPro();
      const { fulfilment } = await buyAddon();
      const client = await testDatabase.newPgClient();

      await expect(
        client.query(
          `INSERT INTO payments
             (user_id, subscription_id, addon_purchase_id, type, status, amount,
              currency, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'ADDON_ONE_TIME', 'SUCCEEDED',
                   1000, 'usd', now())`,
          [userId, pro.id, fulfilment.purchase.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  // ==========================================================================
  describe('Requirement: Credit History Is Complete', () => {
    it('Allocation appears in history', async () => {
      const invoice = { type: 'invoice.paid', id: 'in_test_allocation' };
      await freeThenPro(userId, BillingInterval.MONTH, invoice);

      const history = await creditHistory.listCreditHistory(userId, productId);

      expect(history).toHaveLength(1);
      expect(history[0].type).toBe(CreditTransactionType.ALLOCATION);
      expect(history[0].amount).toBe(100);
      expect(history[0].balanceAfter).toBe(100);
      expect(history[0].relatedEventType).toBe('invoice.paid');
      expect(history[0].relatedEventId).toBe('in_test_allocation');
    });

    it('Reset appears in history', async () => {
      const pro = await freeThenPro();
      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: pro.planId },
      });
      const next = creditPeriodFrom(
        pro.nextCreditResetAt!,
        creditPolicyOf(plan),
      );

      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: pro.id,
        creditPeriodStart: next.start,
        creditPeriodEnd: next.end,
        amount: plan.creditsPerPeriod,
        relatedEvent: { type: 'invoice.paid', id: 'in_test_renewal' },
      });

      const history = await creditHistory.listCreditHistory(userId, productId);
      // The reset is not a type of its own: it reads as the outgoing period's
      // expiry followed by the new period's allocation.
      expect(history.map((h) => h.type)).toEqual([
        CreditTransactionType.ALLOCATION,
        CreditTransactionType.EXPIRY,
        CreditTransactionType.ALLOCATION,
      ]);
      expect(history.map((h) => h.amount)).toEqual([100, -100, 100]);
      expect(history.map((h) => h.balanceAfter)).toEqual([100, 0, 100]);
      // Unspent credit did not roll over: one period's worth, not two.
      expect(history.at(-1)!.balanceAfter).toBe(100);
    });

    it('Consumption appears in history', async () => {
      await freeThenPro();
      await buyAddon();

      // 120 drains the subscription grant first, then reaches the add-on.
      await credits.consume({
        userId,
        productId,
        requestId: 'req-across-two-grants',
        amount: 120,
        entitlement: { kind: 'live', isPaidPlan: true, isPastDue: false },
      });

      const consumption = (
        await creditHistory.listCreditHistory(userId, productId)
      ).filter((h) => h.type === CreditTransactionType.CONSUMPTION);
      expect(consumption).toHaveLength(2);
      expect(consumption.map((c) => c.amount)).toEqual([-100, -20]);
      expect(consumption.map((c) => c.grantBalanceAfter)).toEqual([0, 80]);
      // One movement, so both rows share an operation.
      expect(consumption[0].operationId).toBe(consumption[1].operationId);
      expect(consumption.at(-1)!.balanceAfter).toBe(80);
    });

    it('History is product scoped', async () => {
      await freeThenPro();
      const otherProduct = await testDatabase.prisma.product.create({
        data: { key: `other-${randomUUID()}`, name: 'Other' },
      });
      await testDatabase.prisma.creditGrant.create({
        data: {
          userId,
          productId: otherProduct.id,
          source: CreditGrantSource.ADJUSTMENT,
          amountInitial: 7,
          amountRemaining: 7,
          priority: 1,
          transactions: {
            create: {
              operationId: randomUUID(),
              type: CreditTransactionType.ADJUSTMENT,
              amount: 7,
              grantAmountRemainingAfter: 7,
            },
          },
        },
      });

      const ai = await creditHistory.listCreditHistory(userId, productId);
      const other = await creditHistory.listCreditHistory(
        userId,
        otherProduct.id,
      );

      expect(ai.map((h) => h.amount)).toEqual([100]);
      expect(other.map((h) => h.amount)).toEqual([7]);
    });

    it('Balance impact is carried by the ledger entry', async () => {
      await freeThenPro();
      await buyAddon();
      await credits.consume({
        userId,
        productId,
        requestId: 'req-reconcile',
        amount: 30,
        entitlement: { kind: 'live', isPaidPlan: true, isPastDue: false },
      });

      // No authoritative balance-impact column exists apart from the signed
      // amount on the ledger entry.
      const columns = await testDatabase.prisma.$queryRaw<
        { table_name: string; column_name: string }[]
      >`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('credit_grants', 'credit_transactions')
      `;
      const names = columns.map((c) => c.column_name);
      expect(names).toContain('amount');
      expect(names.filter((n) => /balance_impact|impact/.test(n))).toEqual([]);

      // And a grant's remaining amount is reconcilable by replaying the ledger.
      const grants = await testDatabase.prisma.creditGrant.findMany({
        where: { userId, productId },
      });
      const remaining = grants.reduce((sum, g) => sum + g.amountRemaining, 0);
      const history = await creditHistory.listCreditHistory(userId, productId);
      expect(history.at(-1)!.balanceAfter).toBe(remaining);

      for (const grant of grants) {
        const perGrant = history
          .filter((h) => h.grantId === grant.id)
          .reduce((sum, h) => sum + h.amount, 0);
        expect(perGrant).toBe(grant.amountRemaining);
      }
    });
  });

  // ==========================================================================
  describe('Requirement: Billing State Is Readable', () => {
    it('Reading state on Free', async () => {
      const free = await provisioning.provisionFreeSubscription(
        userId,
        productId,
      );
      await allocateFirstCreditPeriod(free);

      const current = await state();

      expect(current.subscription).toMatchObject({
        planKey: 'free',
        isPaidPlan: false,
        status: SubscriptionStatus.ACTIVE,
        billingInterval: BillingInterval.MONTH,
        billingIntervalCount: 1,
        willRenew: true,
      });
      expect(current.subscription!.currentPeriodStart).toBeInstanceOf(Date);
      expect(current.subscription!.currentPeriodEnd).toBeInstanceOf(Date);
      expect(current.credits).toMatchObject({
        spendable: 50,
        frozen: 0,
        freezeReason: null,
      });
      expect(current.consumptionFrozen).toBe(false);
    });

    it('Reading state while past due', async () => {
      const pro = await freeThenPro();
      await buyAddon();
      // The provider reports the renewal failed; the dunning phase owns the
      // webhook that delivers it.
      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: { status: SubscriptionStatus.PAST_DUE, paymentAttemptCount: 2 },
      });

      const current = await state();

      expect(current.subscription).toMatchObject({
        planKey: 'pro',
        status: SubscriptionStatus.PAST_DUE,
        paymentAttemptCount: 2,
      });
      expect(current.consumptionFrozen).toBe(true);
      expect(current.credits.freezeReason).toBe('PAST_DUE');
      // Preserved rather than zeroed.
      expect(current.credits).toMatchObject({
        spendable: 0,
        frozen: 200,
        total: 200,
      });
    });

    it('Balance excludes unspendable grants', async () => {
      const pro = await freeThenPro();
      await buyAddon();
      await lifecycle.cancelImmediately(pro.id);
      const free = await testDatabase.prisma.subscription.findFirstOrThrow({
        where: { userId, productId, status: SubscriptionStatus.ACTIVE },
      });
      await allocateFirstCreditPeriod(free);

      const current = await state();

      // The two numbers are distinguishable: Free's own credit is spendable, the
      // add-on credit is preserved but frozen.
      expect(current.credits).toMatchObject({
        spendable: 50,
        frozen: 100,
        total: 150,
      });
      expect(current.consumptionFrozen).toBe(false);
    });

    it('A pending period-end cancellation is visible without changing the plan', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelAtPeriodEnd(pro.id);

      const current = await state();
      expect(current.subscription).toMatchObject({
        id: pro.id,
        planKey: 'pro',
        isPaidPlan: true,
        status: SubscriptionStatus.ACTIVE,
        willRenew: false,
        cancelAtPeriodEnd: true,
      });
      expect(current.subscription!.currentPeriodEnd).toEqual(
        pro.currentPeriodEnd,
      );
      expect(current.credits.spendable).toBe(100);
      expect(current.consumptionFrozen).toBe(false);
    });
  });
});
