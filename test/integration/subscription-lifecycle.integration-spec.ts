import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { creditPolicyOf } from '../../src/catalog/credit-policy';
import { stringMatching } from './matchers';
import { creditPeriodFrom } from '../../src/credits/credit-period';
import { CreditRepository } from '../../src/credits/credit.repository';
import { CreditsService } from '../../src/credits/credits.service';
import { CustomersService } from '../../src/customers/customers.service';
import {
  BillingInterval,
  CreditGrantSource,
  CreditTransactionType,
  PaymentStatus,
  PaymentType,
  SubscriptionStatus,
} from '../../src/generated/prisma/enums';
import type { SubscriptionModel } from '../../src/generated/prisma/models';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import { FakeBillingProvider } from '../../src/provider/testing/fake-billing.provider';
import { ProvisioningService } from '../../src/subscriptions/provisioning.service';
import { SubscriptionLifecycleService } from '../../src/subscriptions/subscription-lifecycle.service';
import { SubscriptionLookupService } from '../../src/subscriptions/subscription-lookup.service';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository';
import {
  PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS,
  toEntitlementState,
} from '../../src/subscriptions/subscription-status';
import { testDatabase } from './test-database';

/**
 * The subscription lifecycle, asserted against `specs/subscription-lifecycle`.
 * Scenario names are used verbatim as test names so coverage is auditable by
 * grep rather than by judgement.
 *
 * Three of the spec's requirements are covered elsewhere and are deliberately
 * not duplicated here:
 *
 * - *One Live Subscription Per User Per Product* and *Subscription Identity Is
 *   Permanent* — `stripe-provisioning.integration-spec.ts`, since they are
 *   properties of provisioning and of the database constraints.
 * - *Payment Failure Grace Period* — the dunning phase, which owns the webhook
 *   that delivers a failed payment.
 *
 * Two scenarios of *Free Provisioning Has Exactly Two Triggers* are likewise
 * elsewhere: "Registration provisions Free" belongs to the authentication phase
 * that owns registration, and "Provisioning is idempotent" is asserted in the
 * provisioning suite.
 */

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);
const PRO_ANNUAL_PRICE = PRICE_IDS.STRIPE_PRICE_AI_PRO_ANNUAL;

const CHECKOUT_URLS = {
  successUrl: 'https://test.local/success',
  cancelUrl: 'https://test.local/cancel',
};

type SubscriptionWithPlan = SubscriptionModel & {
  plan: { key: string; isPaid: boolean };
};

describe('subscription-lifecycle', () => {
  let moduleRef: TestingModule;
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
        ProvisioningService,
        SubscriptionLifecycleService,
        SubscriptionLookupService,
        SubscriptionRepository,
        CreditRepository,
        CreditsService,
        CustomersService,
        { provide: BILLING_PROVIDER, useValue: provider },
      ],
    }).compile();
    await moduleRef.init();

    provisioning = moduleRef.get(ProvisioningService);
    lifecycle = moduleRef.get(SubscriptionLifecycleService);
    credits = moduleRef.get(CreditsService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    provider.reset();
    // The annual SKU bills yearly at the provider. Its credit period is still
    // monthly, which is the divergence several tests below turn on.
    provider.priceIntervals.set(PRO_ANNUAL_PRICE, 'year');

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

  /**
   * Walks the path Stripe drives: a checkout session is created, the customer
   * pays, and the resulting subscription's first invoice is paid. Only the last
   * step has any local entitlement effect.
   */
  async function upgradeToPro(
    forUser = userId,
    billingInterval: BillingInterval = BillingInterval.MONTH,
  ): Promise<SubscriptionModel> {
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
    });
  }

  async function freeThenPro(
    forUser = userId,
    billingInterval: BillingInterval = BillingInterval.MONTH,
  ): Promise<SubscriptionModel> {
    await provisionFree(forUser);
    return upgradeToPro(forUser, billingInterval);
  }

  function liveSubscriptions(
    forUser = userId,
  ): Promise<SubscriptionWithPlan[]> {
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

  async function theLiveSubscription(
    forUser = userId,
  ): Promise<SubscriptionWithPlan> {
    const live = await liveSubscriptions(forUser);
    expect(live).toHaveLength(1);
    return live[0];
  }

  function reload(subscriptionId: string): Promise<SubscriptionModel> {
    return testDatabase.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
  }

  function grantsOf(subscriptionId: string) {
    return testDatabase.prisma.creditGrant.findMany({
      where: { subscriptionId },
      orderBy: { creditPeriodStart: 'asc' },
    });
  }

  /**
   * Stands in for the `$0 invoice.paid` the new Free subscription emits. The
   * webhook that delivers it belongs to a later phase; the allocation routine
   * it writes through is the one used here, which is the point — the Free plan's
   * credits arrive by the standing path, not from the transition (design D4b).
   */
  async function allocateFirstCreditPeriod(
    subscription: SubscriptionModel,
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
    });
  }

  async function grantAddonCredits(amount: number): Promise<void> {
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
      amount,
    });
  }

  async function balance() {
    const live = await liveSubscriptions();
    return credits.getBalance(
      userId,
      productId,
      toEntitlementState(
        live.length === 1
          ? { status: live[0].status, isPaidPlan: live[0].plan.isPaid }
          : null,
      ),
    );
  }

  // ==========================================================================
  describe('Requirement: Subscription Status Is Provider-Owned', () => {
    it('No status exists without a provider counterpart', () => {
      const reported = new Set(
        Object.values(PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS),
      );

      for (const status of Object.values(SubscriptionStatus)) {
        expect(reported.has(status)).toBe(true);
      }
    });

    it('Free is a plan, not a status', async () => {
      await provisionFree();

      const live = await theLiveSubscription();

      expect(live.plan.key).toBe('free');
      // Its status is the provider's status for its own Stripe subscription.
      expect(live.status).toBe(
        provider.subscriptions.get(live.providerSubscriptionId)!.status,
      );
      expect(Object.values(SubscriptionStatus) as string[]).not.toContain(
        'FREE',
      );
    });

    it('Local status follows the provider', async () => {
      const pro = await freeThenPro();

      // The provider ends the subscription; the local row follows it there.
      const ended = await provider.cancelSubscriptionNow(
        pro.providerSubscriptionId,
      );
      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      expect((await reload(pro.id)).status).toBe(ended.status);
    });

    it('Entitlement is derived, not stored as a status', async () => {
      await freeThenPro();

      const live = await theLiveSubscription();
      const entitlement = toEntitlementState({
        status: live.status,
        isPaidPlan: live.plan.isPaid,
      });

      // Derived from the live Subscription's Plan and provider status, with no
      // entitlement or downgrade column involved.
      expect(entitlement).toEqual({
        kind: 'live',
        isPaidPlan: true,
        isPastDue: false,
      });
      expect(Object.keys(live)).not.toContain('entitlement');
    });
  });

  // ==========================================================================
  describe('Requirement: Free Provisioning Has Exactly Two Triggers', () => {
    it('Requesting cancellation at period end does not provision Free', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelAtPeriodEnd(pro.id);

      const live = await theLiveSubscription();
      expect(live.id).toBe(pro.id);
      expect(live.plan.isPaid).toBe(true);
      // No Free row was created at all — not merely none that is live.
      const freeRows = await testDatabase.prisma.subscription.count({
        where: { userId, productId, plan: { isPaid: false } },
      });
      expect(freeRows).toBe(1); // the original, now terminal
      expect(
        (
          await testDatabase.prisma.subscription.findFirstOrThrow({
            where: { userId, productId, plan: { isPaid: false } },
          })
        ).status,
      ).toBe(SubscriptionStatus.CANCELED);
    });

    it('End of paid entitlement provisions Free', async () => {
      const pro = await freeThenPro();
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);

      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      const live = await theLiveSubscription();
      expect(live.plan.isPaid).toBe(false);
      expect(live.id).not.toBe(pro.id);
    });

    // "No other flow provisions Free" enumerates code paths rather than
    // observing state, so it is asserted against the source in
    // `src/subscriptions/lifecycle-boundaries.spec.ts`.
  });

  // ==========================================================================
  describe('Requirement: Paid Subscriptions Are Created By Payment', () => {
    it('Checkout request does not create a row', async () => {
      const free = await provisionFree();

      const checkout = await lifecycle.createProCheckout({
        userId,
        productId,
        billingInterval: BillingInterval.MONTH,
        ...CHECKOUT_URLS,
      });

      const rows = await testDatabase.prisma.subscription.findMany({
        where: { userId, productId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(free.id);
      expect(await testDatabase.prisma.creditGrant.count()).toBe(0);
      // Only the checkout session reference is recorded.
      const recorded =
        await testDatabase.prisma.subscriptionCheckout.findUniqueOrThrow({
          where: { providerCheckoutSessionId: checkout.checkoutSessionId },
        });
      expect(recorded.userId).toBe(userId);
    });

    it('Checkout abandoned at card authentication', async () => {
      const free = await provisionFree();
      const checkout = await lifecycle.createProCheckout({
        userId,
        productId,
        billingInterval: BillingInterval.MONTH,
        ...CHECKOUT_URLS,
      });

      // Stripe reports the subscription incomplete, then expires it.
      const abandoned = provider.completeCheckout(checkout.checkoutSessionId, {
        status: SubscriptionStatus.INCOMPLETE,
      });
      await expect(
        lifecycle.transitionFreeToPro({
          userId,
          productId,
          providerSubscriptionId: abandoned.id,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBSCRIPTION_STATE' });

      const paidRows = await testDatabase.prisma.subscription.count({
        where: { userId, productId, plan: { isPaid: true } },
      });
      expect(paidRows).toBe(0);
      const live = await theLiveSubscription();
      expect(live.id).toBe(free.id);
      expect(live.status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('Checkout creates no entitlement', async () => {
      await provisionFree();

      await lifecycle.createProCheckout({
        userId,
        productId,
        billingInterval: BillingInterval.MONTH,
        ...CHECKOUT_URLS,
      });

      expect(await testDatabase.prisma.creditGrant.count()).toBe(0);
      expect(await testDatabase.prisma.creditTransaction.count()).toBe(0);
      expect(
        await testDatabase.prisma.subscription.count({
          where: { plan: { isPaid: true } },
        }),
      ).toBe(0);
    });

    it('Checkout reference is recorded for correlation', async () => {
      await provisionFree();

      const checkout = await lifecycle.createProCheckout({
        userId,
        productId,
        billingInterval: BillingInterval.MONTH,
        ...CHECKOUT_URLS,
      });

      const recorded =
        await testDatabase.prisma.subscriptionCheckout.findUniqueOrThrow({
          where: { providerCheckoutSessionId: checkout.checkoutSessionId },
          include: { pricingOption: true },
        });
      expect(recorded.userId).toBe(userId);
      expect(recorded.productId).toBe(productId);
      expect(recorded.pricingOption.stripePriceId).toBe(
        PRICE_IDS.STRIPE_PRICE_AI_PRO_MONTHLY,
      );
    });

    it('Pro requires a valid payment method', async () => {
      await provisionFree();

      const checkout = await lifecycle.createProCheckout({
        userId,
        productId,
        billingInterval: BillingInterval.MONTH,
        ...CHECKOUT_URLS,
      });

      // The flow collects payment details through the checkout session, and no
      // subscription exists at the provider until that completes.
      expect(checkout.url).toBeTruthy();
      expect(provider.callsTo('createSubscription')).toHaveLength(1); // Free only
      expect(provider.liveSubscriptions()).toHaveLength(1);
    });
  });

  // ==========================================================================
  describe('Requirement: Free To Pro Transition', () => {
    it('First successful Pro payment', async () => {
      const free = await provisionFree();

      const pro = await upgradeToPro();

      expect((await reload(free.id)).status).toBe(SubscriptionStatus.CANCELED);
      const live = await theLiveSubscription();
      expect(live.id).toBe(pro.id);
      expect(live.plan.isPaid).toBe(true);
      expect(live.providerSubscriptionId).not.toBe(free.providerSubscriptionId);

      const granted = await grantsOf(pro.id);
      expect(granted).toHaveLength(1);
      expect(granted[0].amountRemaining).toBe(100);
      expect(granted[0].source).toBe(CreditGrantSource.SUBSCRIPTION);
    });

    it('Stripe cleanup after the transition fails', async () => {
      const free = await provisionFree();
      provider.failNext(
        'cancelSubscriptionNow',
        new Error('provider unavailable'),
      );

      const pro = await upgradeToPro();

      // The local commit stands; the orphan is reconciliation's problem.
      const live = await theLiveSubscription();
      expect(live.id).toBe(pro.id);
      expect(live.plan.isPaid).toBe(true);
      expect(
        provider.subscriptions.get(free.providerSubscriptionId)!.status,
      ).toBe(SubscriptionStatus.ACTIVE);
    });

    it('No Stripe call inside the transaction', async () => {
      const free = await provisionFree();
      provider.failNext(
        'cancelSubscriptionNow',
        new Error('provider unavailable'),
      );

      // The cleanup call failing cannot roll the transition back, which is only
      // true if the commit happened first.
      const pro = await upgradeToPro();

      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.ACTIVE);
      expect((await reload(free.id)).status).toBe(SubscriptionStatus.CANCELED);
      expect(await grantsOf(pro.id)).toHaveLength(1);
    });

    it('Transition commits before cleanup', async () => {
      const free = await provisionFree();

      const pro = await upgradeToPro();

      // The cancellation of the superseded Free subscription is the last thing
      // to happen, after the row it supersedes is already terminal locally.
      const cancelled = provider.callsTo('cancelSubscriptionNow');
      expect(cancelled).toEqual([free.providerSubscriptionId]);
      expect(provider.liveSubscriptions().map((s) => s.id)).toEqual([
        pro.providerSubscriptionId,
      ]);
    });
  });

  // ==========================================================================
  describe('Requirement: Pro To Free Transition', () => {
    it('Downgrade to free', async () => {
      const pro = await freeThenPro();
      await grantAddonCredits(40);
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);

      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      const live = await theLiveSubscription();
      expect(live.id).not.toBe(pro.id);
      expect(live.plan.isPaid).toBe(false);
      expect(live.providerSubscriptionId).not.toBe(pro.providerSubscriptionId);

      for (const grant of await grantsOf(pro.id)) {
        expect(grant.amountRemaining).toBe(0);
      }
      // Add-on credit is preserved, and unspendable on Free.
      const after = await balance();
      expect(after.frozen).toBe(40);
      expect(after.spendable).toBe(0);
    });

    it('The plan change is a new row, not a status change', async () => {
      const pro = await freeThenPro();
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);

      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      const rows = await testDatabase.prisma.subscription.findMany({
        where: { userId, productId },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(3); // Free, Pro, Free
      const statuses = new Set(rows.map((r) => r.status));
      for (const status of statuses) {
        expect(Object.values(SubscriptionStatus)).toContain(status);
      }
      // The change is one row leaving the live set and another entering it.
      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
      expect((await theLiveSubscription()).id).toBe(rows[2].id);
    });

    it('A subscription the provider has ended is never revived', async () => {
      const pro = await freeThenPro();
      await lifecycle.cancelImmediately(pro.id);

      const client = await testDatabase.newPgClient();
      await expect(
        client.query(
          `UPDATE subscriptions SET status = 'ACTIVE' WHERE id = $1::uuid`,
          [pro.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });

      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
    });
  });

  // ==========================================================================
  describe('Requirement: Billing Cycle Change Reuses The Provider Subscription', () => {
    it('Switch monthly to annual', async () => {
      const pro = await freeThenPro();

      const switched = await lifecycle.changeCycle(
        pro.id,
        BillingInterval.YEAR,
      );

      expect(switched.id).toBe(pro.id);
      expect(switched.providerSubscriptionId).toBe(pro.providerSubscriptionId);
      expect(switched.pricingOptionId).not.toBe(pro.pricingOptionId);
      expect(
        provider.subscriptions.get(pro.providerSubscriptionId)!.priceId,
      ).toBe(PRO_ANNUAL_PRICE);
      // No new provider subscription, and no grant at the moment of the switch.
      expect(provider.callsTo('createSubscription')).toHaveLength(1);
      expect(await grantsOf(pro.id)).toHaveLength(1);
    });

    it('Cycle change does not move the credit period', async () => {
      const pro = await freeThenPro();
      const before = await reload(pro.id);

      await lifecycle.changeCycle(pro.id, BillingInterval.YEAR);

      const after = await reload(pro.id);
      expect(after.nextCreditResetAt).toEqual(before.nextCreditResetAt);
      const granted = await grantsOf(pro.id);
      expect(granted).toHaveLength(1);
      expect(granted[0].creditPeriodEnd).toEqual(before.nextCreditResetAt);
      // The billing period did move — the credit period is what did not.
      expect(after.currentPeriodEnd).not.toEqual(before.currentPeriodEnd);
    });

    it('Next invoice grants one credit period, not a year', async () => {
      const pro = await freeThenPro();
      await lifecycle.changeCycle(pro.id, BillingInterval.YEAR);

      // The annual invoice is paid; allocation still covers one month.
      const annual = await reload(pro.id);
      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: annual.planId },
      });
      const nextPeriod = creditPeriodFrom(
        annual.nextCreditResetAt!,
        creditPolicyOf(plan),
      );
      const { grant } = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: pro.id,
        creditPeriodStart: nextPeriod.start,
        creditPeriodEnd: nextPeriod.end,
        amount: plan.creditsPerPeriod,
      });

      expect(grant.amountInitial).toBe(100);
      const monthLater = new Date(nextPeriod.start);
      monthLater.setUTCMonth(monthLater.getUTCMonth() + 1);
      expect(grant.creditPeriodEnd).toEqual(monthLater);
      // A year of credit was not released at once.
      expect(annual.currentPeriodEnd!.getTime()).toBeGreaterThan(
        grant.creditPeriodEnd!.getTime(),
      );
    });
  });

  // ==========================================================================
  describe('Requirement: Purchase Refused When A Paid Subscription Is Live', () => {
    it('Duplicate purchase attempt', async () => {
      await freeThenPro();

      const before = provider.calls.length;
      await expect(
        lifecycle.createProCheckout({
          userId,
          productId,
          billingInterval: BillingInterval.YEAR,
          ...CHECKOUT_URLS,
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_SUBSCRIPTION_STATE',
        // The refusal names the operations that are available instead.
        message: stringMatching(/change (the )?cycle|reactivate/i),
      });

      // Refused before any provider call, so no second Stripe subscription.
      expect(provider.calls.length).toBe(before);
      expect(await liveSubscriptions()).toHaveLength(1);
    });
  });

  // ==========================================================================
  describe('Requirement: Two Distinct Cancellation Modes Are Offered', () => {
    it('The two modes are separately addressable', () => {
      // `unbound-method` is disabled deliberately: referencing the methods
      // without calling them is exactly what this test asserts — that the two
      // cancellations are two distinct functions of one argument, not one
      // function behind a mode flag. Binding them would defeat the assertion.
      /* eslint-disable @typescript-eslint/unbound-method */
      expect(typeof lifecycle.cancelAtPeriodEnd).toBe('function');
      expect(typeof lifecycle.cancelImmediately).toBe('function');
      expect(lifecycle.cancelAtPeriodEnd).not.toBe(lifecycle.cancelImmediately);
      // Neither takes a mode flag: each is reached by naming it.
      expect(lifecycle.cancelAtPeriodEnd).toHaveLength(1);
      expect(lifecycle.cancelImmediately).toHaveLength(1);
      /* eslint-enable @typescript-eslint/unbound-method */
    });

    it('The two modes issue different Stripe operations', async () => {
      const atPeriodEnd = await freeThenPro();
      await lifecycle.cancelAtPeriodEnd(atPeriodEnd.id);

      const otherUser = await newUser();
      const immediately = await freeThenPro(otherUser);
      await lifecycle.cancelImmediately(immediately.id);

      const pending = provider.subscriptions.get(
        atPeriodEnd.providerSubscriptionId,
      )!;
      expect(pending.cancelAtPeriodEnd).toBe(true);
      expect(pending.status).toBe(SubscriptionStatus.ACTIVE);

      const ended = provider.subscriptions.get(
        immediately.providerSubscriptionId,
      )!;
      expect(ended.status).toBe(SubscriptionStatus.CANCELED);

      expect(provider.callsTo('cancelSubscriptionAtPeriodEnd')).toEqual([
        atPeriodEnd.providerSubscriptionId,
      ]);
      expect(provider.callsTo('cancelSubscriptionNow')).toContain(
        immediately.providerSubscriptionId,
      );
    });

    it('Neither mode writes a local cancellation status', async () => {
      const atPeriodEnd = await freeThenPro();
      await lifecycle.cancelAtPeriodEnd(atPeriodEnd.id);

      const pending = await reload(atPeriodEnd.id);
      expect(pending.status).toBe(
        provider.subscriptions.get(atPeriodEnd.providerSubscriptionId)!.status,
      );

      const otherUser = await newUser();
      const immediately = await freeThenPro(otherUser);
      await lifecycle.cancelImmediately(immediately.id);

      const ended = await reload(immediately.id);
      expect(ended.status).toBe(
        provider.subscriptions.get(immediately.providerSubscriptionId)!.status,
      );
    });
  });

  // ==========================================================================
  describe('Requirement: Cancel At Period End', () => {
    it('Cancel at period end, period still running', async () => {
      const pro = await freeThenPro();
      const spendableBefore = (await balance()).spendable;

      await lifecycle.cancelAtPeriodEnd(pro.id);

      const row = await reload(pro.id);
      expect(row.status).toBe(SubscriptionStatus.ACTIVE);
      expect(row.cancelAtPeriodEnd).toBe(true);
      expect(
        provider.subscriptions.get(pro.providerSubscriptionId)!.status,
      ).toBe(SubscriptionStatus.ACTIVE);
      const live = await theLiveSubscription();
      expect(live.id).toBe(pro.id);
      expect(live.plan.isPaid).toBe(true);
      expect((await balance()).spendable).toBe(spendableBefore);
    });

    it('A pending cancellation is an intent, not a status', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelAtPeriodEnd(pro.id);

      const row = await reload(pro.id);
      expect(row.status).toBe(SubscriptionStatus.ACTIVE);
      expect(row.cancelAtPeriodEnd).toBe(true);
      expect(Object.values(SubscriptionStatus).map(String)).not.toContain(
        'PENDING_CANCELLATION',
      );
    });

    it('Cancel at period end, then the period ends', async () => {
      const pro = await freeThenPro();
      await lifecycle.cancelAtPeriodEnd(pro.id);

      // Stripe reaches the period end and reports the subscription gone.
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);
      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
      const free = await theLiveSubscription();
      expect(free.plan.isPaid).toBe(false);
      for (const grant of await grantsOf(pro.id)) {
        expect(grant.amountRemaining).toBe(0);
      }

      await allocateFirstCreditPeriod(free);
      expect((await balance()).spendable).toBe(50);
    });

    it('Reactivate before the period ends', async () => {
      const pro = await freeThenPro();
      await lifecycle.cancelAtPeriodEnd(pro.id);

      const reactivated = await lifecycle.reactivate(pro.id);

      expect(reactivated.id).toBe(pro.id);
      expect(reactivated.cancelAtPeriodEnd).toBe(false);
      expect(reactivated.providerSubscriptionId).toBe(
        pro.providerSubscriptionId,
      );
      expect(reactivated.status).toBe(SubscriptionStatus.ACTIVE);
      expect(
        await testDatabase.prisma.subscription.count({
          where: { userId, productId },
        }),
      ).toBe(2); // the original Free row and this one
    });

    it('Credit periods continue during the remaining period', async () => {
      const pro = await freeThenPro(userId, BillingInterval.YEAR);
      await lifecycle.cancelAtPeriodEnd(pro.id);

      // A monthly credit period falls due with months left in the paid year.
      // The scheduled reset that drives this in production is a later phase;
      // what matters here is that the pending intent suppresses nothing.
      const row = await reload(pro.id);
      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: row.planId },
      });
      const nextPeriod = creditPeriodFrom(
        row.nextCreditResetAt!,
        creditPolicyOf(plan),
      );
      const { created, grant } = await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: pro.id,
        creditPeriodStart: nextPeriod.start,
        creditPeriodEnd: nextPeriod.end,
        amount: plan.creditsPerPeriod,
      });

      expect(created).toBe(true);
      expect(grant.amountRemaining).toBe(100);
      expect((await reload(pro.id)).cancelAtPeriodEnd).toBe(true);
      expect((await balance()).spendable).toBe(100);
    });
  });

  // ==========================================================================
  describe('Requirement: Cancel Immediately', () => {
    it('Immediate cancellation ends entitlement at once', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelImmediately(pro.id);

      expect(
        provider.subscriptions.get(pro.providerSubscriptionId)!.status,
      ).toBe(SubscriptionStatus.CANCELED);
      expect(
        provider.subscriptions.get(pro.providerSubscriptionId)!
          .cancelAtPeriodEnd,
      ).toBe(false);
      const live = await theLiveSubscription();
      expect(live.plan.isPaid).toBe(false);
      expect(live.plan.key).toBe('free');
    });

    it('The transition is driven by provider state', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelImmediately(pro.id);

      const calls = provider.calls.map((c) => c.method);
      // The provider is told first; the local row follows what it reports.
      expect(calls.indexOf('cancelSubscriptionNow')).toBeLessThan(
        calls.lastIndexOf('createSubscription'),
      );
      expect((await reload(pro.id)).status).toBe(
        provider.subscriptions.get(pro.providerSubscriptionId)!.status,
      );
    });

    it('A lost cancellation acknowledgement still converges', async () => {
      const pro = await freeThenPro();
      // The Stripe cancellation succeeded, but its result never came back.
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);

      // The webhook arrives, and then reconciliation runs.
      await lifecycle.transitionProToFree({ subscriptionId: pro.id });
      const created = provider.callsTo('createSubscription').length;
      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      const live = await theLiveSubscription();
      expect(live.plan.isPaid).toBe(false);
      // The second pass creates nothing, at the provider or locally.
      expect(provider.callsTo('createSubscription')).toHaveLength(created);
      expect(
        await testDatabase.prisma.subscription.count({
          where: { userId, productId },
        }),
      ).toBe(3);
    });

    it('Immediate cancellation issues no refund', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelImmediately(pro.id);

      // The provider seam offers no refund operation at all, so no path can
      // request one by accident.
      expect(provider.calls.map((c) => c.method)).not.toContain('createRefund');
      expect(
        provider.calls.filter((c) => /refund/i.test(c.method)),
      ).toHaveLength(0);
    });

    it('An already-successful charge is left untouched', async () => {
      const pro = await freeThenPro();
      const charge = await testDatabase.prisma.payment.create({
        data: {
          userId,
          subscriptionId: pro.id,
          type: PaymentType.SUBSCRIPTION_RECURRING,
          status: PaymentStatus.SUCCEEDED,
          amount: 2000,
          currency: 'usd',
          providerInvoiceId: `in_${randomUUID()}`,
        },
      });

      await lifecycle.cancelImmediately(pro.id);

      const after = await testDatabase.prisma.payment.findUniqueOrThrow({
        where: { id: charge.id },
      });
      expect(after.amount).toBe(charge.amount);
      expect(after.status).toBe(PaymentStatus.SUCCEEDED);
      expect(after.updatedAt).toEqual(charge.updatedAt);
      expect(await testDatabase.prisma.payment.count()).toBe(1);
    });

    it('Credits follow the standing freeze rules', async () => {
      const pro = await freeThenPro();
      await grantAddonCredits(60);
      expect((await balance()).spendable).toBe(160);

      await lifecycle.cancelImmediately(pro.id);

      const onFree = await balance();
      expect(onFree.frozen).toBe(60);
      expect(onFree.spendable).toBe(0);

      // A qualifying paid subscription makes exactly the same rows spendable.
      const secondPro = await upgradeToPro();
      const onPro = await balance();
      expect(onPro.frozen).toBe(0);
      expect(onPro.spendable).toBe(160);
      expect(secondPro.id).not.toBe(pro.id);
    });

    it('An immediate cancellation cannot be reactivated', async () => {
      const pro = await freeThenPro();
      await lifecycle.cancelImmediately(pro.id);

      await expect(lifecycle.reactivate(pro.id)).rejects.toMatchObject({
        code: 'INVALID_SUBSCRIPTION_STATE',
      });

      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
      expect((await theLiveSubscription()).plan.isPaid).toBe(false);
    });
  });

  // ==========================================================================
  describe('Requirement: All Pro To Free Transitions Converge On One Routine', () => {
    /** The three ways Pro entitlement can end, each reaching the same routine. */
    const paths: Record<
      string,
      (
        lifecycle: SubscriptionLifecycleService,
        provider: FakeBillingProvider,
        pro: SubscriptionModel,
      ) => Promise<unknown>
    > = {
      'a period-end cancellation taking effect': async (l, p, pro) => {
        await l.cancelAtPeriodEnd(pro.id);
        await p.cancelSubscriptionNow(pro.providerSubscriptionId);
        return l.transitionProToFree({ subscriptionId: pro.id });
      },
      'an immediate cancellation': (l, _p, pro) => l.cancelImmediately(pro.id),
      'exhausted dunning': async (l, p, pro) => {
        await testDatabase.prisma.subscription.update({
          where: { id: pro.id },
          data: { status: SubscriptionStatus.PAST_DUE },
        });
        await p.cancelSubscriptionNow(pro.providerSubscriptionId);
        return l.transitionProToFree({ subscriptionId: pro.id });
      },
    };

    it('The same end state results from each path', async () => {
      for (const [name, take] of Object.entries(paths)) {
        const forUser = await newUser();
        const pro = await freeThenPro(forUser);
        const addonPackage =
          await testDatabase.prisma.addonPackage.findFirstOrThrow({
            where: { productId },
          });
        const purchase = await testDatabase.prisma.addonPurchase.create({
          data: { userId: forUser, productId, addonPackageId: addonPackage.id },
        });
        await credits.grantAddonCredits({
          userId: forUser,
          productId,
          addonPurchaseId: purchase.id,
          amount: 30,
        });

        await take(lifecycle, provider, pro);

        const live = await liveSubscriptions(forUser);
        expect(live).toHaveLength(1);
        expect(live[0].plan.isPaid).toBe(false);
        expect(live[0].id).not.toBe(pro.id);

        for (const grant of await grantsOf(pro.id)) {
          expect(grant.amountRemaining).toBe(0);
        }
        const addonGrants = await testDatabase.prisma.creditGrant.findMany({
          where: { userId: forUser, source: CreditGrantSource.ADDON },
        });
        expect(addonGrants.map((g) => g.amountRemaining)).toEqual([30]);

        const onFree = await credits.getBalance(
          forUser,
          productId,
          toEntitlementState({
            status: live[0].status,
            isPaidPlan: live[0].plan.isPaid,
          }),
        );
        expect({ path: name, ...onFree }).toMatchObject({
          spendable: 0,
          frozen: 30,
        });
      }
    });

    it('The routine writes no Free grant of its own', async () => {
      const pro = await freeThenPro();
      await provider.cancelSubscriptionNow(pro.providerSubscriptionId);

      await lifecycle.transitionProToFree({ subscriptionId: pro.id });

      const free = await theLiveSubscription();
      expect(await grantsOf(free.id)).toEqual([]);
      // It arrives through the ordinary allocation path instead.
      await allocateFirstCreditPeriod(free);
      const granted = await grantsOf(free.id);
      expect(granted).toHaveLength(1);
      expect(granted[0].amountRemaining).toBe(50);
    });

    it('The routine is not reachable without provider confirmation', async () => {
      const pro = await freeThenPro();

      // A request alone is not provider-confirmed state.
      await lifecycle.cancelAtPeriodEnd(pro.id);
      await expect(
        lifecycle.transitionProToFree({ subscriptionId: pro.id }),
      ).rejects.toMatchObject({ code: 'INVALID_SUBSCRIPTION_STATE' });

      const live = await theLiveSubscription();
      expect(live.id).toBe(pro.id);
      expect(live.plan.isPaid).toBe(true);
      expect(await grantsOf(pro.id)).toHaveLength(1);
      expect((await grantsOf(pro.id))[0].amountRemaining).toBe(100);
    });

    it('No refund on any path', async () => {
      for (const take of Object.values(paths)) {
        const forUser = await newUser();
        const pro = await freeThenPro(forUser);

        await take(lifecycle, provider, pro);
      }

      expect(
        provider.calls.filter((c) => /refund/i.test(c.method)),
      ).toHaveLength(0);
      expect(Object.keys(provider).some((k) => /refund/i.test(k))).toBe(false);
    });
  });

  // ==========================================================================
  // Task 5.14 / 5.14a — the credit lifecycle across the two cancellation modes.
  // ==========================================================================
  describe('the two cancellation modes are not one behaviour', () => {
    it('requesting a period-end cancellation provisions no Free row, expires no credits, and leaves the user entitled to Pro', async () => {
      const pro = await freeThenPro();
      const before = await grantsOf(pro.id);

      await lifecycle.cancelAtPeriodEnd(pro.id);

      const live = await theLiveSubscription();
      expect(live.id).toBe(pro.id);
      expect(live.plan.isPaid).toBe(true);
      expect(await grantsOf(pro.id)).toEqual(before);
      expect(
        await testDatabase.prisma.creditTransaction.count({
          where: { type: CreditTransactionType.EXPIRY },
        }),
      ).toBe(0);
      expect(provider.callsTo('createSubscription')).toHaveLength(1);
    });

    it('a period-end cancellation on an annual subscription still grants its monthly credit periods', async () => {
      const pro = await freeThenPro(userId, BillingInterval.YEAR);
      await lifecycle.cancelAtPeriodEnd(pro.id);

      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: pro.planId },
      });

      // The transition's own grant covers one month, not the paid year: the
      // credit period comes from the plan's policy and the billing period from
      // the SKU, and on this cycle they diverge.
      const first = (await grantsOf(pro.id))[0];
      expect(first.creditPeriodEnd).toEqual(
        creditPeriodFrom(first.creditPeriodStart!, creditPolicyOf(plan)).end,
      );
      expect(pro.currentPeriodEnd!.getTime()).toBeGreaterThan(
        first.creditPeriodEnd!.getTime(),
      );
      expect(pro.nextCreditResetAt).toEqual(first.creditPeriodEnd);
      let period = creditPeriodFrom(
        pro.currentPeriodStart!,
        creditPolicyOf(plan),
      );
      for (let month = 1; month < 4; month++) {
        period = creditPeriodFrom(period.end, creditPolicyOf(plan));
        await credits.allocateSubscriptionCredits({
          userId,
          productId,
          subscriptionId: pro.id,
          creditPeriodStart: period.start,
          creditPeriodEnd: period.end,
          amount: plan.creditsPerPeriod,
        });
      }

      // Four periods granted, one live, and only the current one spendable.
      expect(await grantsOf(pro.id)).toHaveLength(4);
      expect((await balance()).spendable).toBe(100);
      expect((await theLiveSubscription()).id).toBe(pro.id);
    });

    it('reactivation after an immediate cancellation is refused', async () => {
      const pro = await freeThenPro();
      await lifecycle.cancelImmediately(pro.id);

      await expect(lifecycle.reactivate(pro.id)).rejects.toMatchObject({
        code: 'INVALID_SUBSCRIPTION_STATE',
      });
      expect(provider.callsTo('reactivateSubscription')).toEqual([]);
    });
  });

  describe('the Pro → Free credit lifecycle (design D4b)', () => {
    it('a user who had 80 unspent Pro credits ends with 50, not 80 and not 130', async () => {
      const pro = await freeThenPro();
      await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 20,
        entitlement: { kind: 'live', isPaidPlan: true, isPastDue: false },
      });
      expect((await balance()).spendable).toBe(80);

      await lifecycle.cancelImmediately(pro.id);
      await allocateFirstCreditPeriod(await theLiveSubscription());

      const onFree = await balance();
      expect(onFree.spendable).toBe(50);
      expect(onFree.frozen).toBe(0);
      expect(onFree.total).toBe(50);
    });

    it('expires the departing Pro credits with a ledger movement in each case', async () => {
      const pro = await freeThenPro();

      await lifecycle.cancelImmediately(pro.id);

      const expired = await testDatabase.prisma.creditTransaction.findMany({
        where: {
          type: CreditTransactionType.EXPIRY,
          creditGrant: { subscriptionId: pro.id },
        },
      });
      expect(expired).toHaveLength(1);
      expect(expired[0].amount).toBe(-100);
      expect(expired[0].grantAmountRemainingAfter).toBe(0);
    });

    it('leaves add-on balances unchanged and writes no row for them', async () => {
      const pro = await freeThenPro();
      await grantAddonCredits(75);
      const addonBefore =
        await testDatabase.prisma.creditGrant.findFirstOrThrow({
          where: { source: CreditGrantSource.ADDON },
        });
      const ledgerBefore = await testDatabase.prisma.creditTransaction.count({
        where: { creditGrantId: addonBefore.id },
      });

      await lifecycle.cancelImmediately(pro.id);

      const addonAfter =
        await testDatabase.prisma.creditGrant.findUniqueOrThrow({
          where: { id: addonBefore.id },
        });
      expect(addonAfter).toEqual(addonBefore);
      expect(
        await testDatabase.prisma.creditTransaction.count({
          where: { creditGrantId: addonBefore.id },
        }),
      ).toBe(ledgerBefore);
    });
  });
});
