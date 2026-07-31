import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CatalogModule } from '../../src/catalog/catalog.module';
import { creditPolicyOf } from '../../src/catalog/credit-policy';
import { CLOCK, FixedClock } from '../../src/common/clock';
import { creditPeriodFrom } from '../../src/credits/credit-period';
import { CreditRepository } from '../../src/credits/credit.repository';
import { CreditsService } from '../../src/credits/credits.service';
import { CustomersService } from '../../src/customers/customers.service';
import {
  BillingInterval,
  CreditTransactionType,
  SubscriptionStatus,
} from '../../src/generated/prisma/enums';
import type { SubscriptionModel } from '../../src/generated/prisma/models';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import { FakeBillingProvider } from '../../src/provider/testing/fake-billing.provider';
import { CreditResetJob } from '../../src/reconciliation/credit-reset.job';
import { DriftDetectionJob } from '../../src/reconciliation/drift-detection.job';
import { LiveSubscriptionRepairJob } from '../../src/reconciliation/live-subscription-repair.job';
import { OrphanCleanupJob } from '../../src/reconciliation/orphan-cleanup.job';
import { ProvisioningService } from '../../src/subscriptions/provisioning.service';
import { SubscriptionLifecycleService } from '../../src/subscriptions/subscription-lifecycle.service';
import { SubscriptionLookupService } from '../../src/subscriptions/subscription-lookup.service';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository';
import { toEntitlementState } from '../../src/subscriptions/subscription-status';
import { testDatabase } from './test-database';

/**
 * Reconciliation, asserted against `specs/billing-reconciliation/spec.md`.
 * Scenario names are used verbatim as test names so coverage is auditable by
 * grep rather than by judgement.
 *
 * Four scenarios are covered at the source level instead, in
 * `src/reconciliation/reconciliation-boundaries.spec.ts`, because they are
 * claims about code that must not exist or about how a claim key is
 * constructed — neither has runtime behaviour to exercise:
 * "The job set is closed", "Job anchors idempotency to a durable marker",
 * "Reset job shares the allocation routine", and the source half of
 * "Drift detection makes no Stripe mutations" (whose runtime half is here).
 */

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);
const PRO_ANNUAL_PRICE = PRICE_IDS.STRIPE_PRICE_AI_PRO_ANNUAL;

const CHECKOUT_URLS = {
  successUrl: 'https://test.local/success',
  cancelUrl: 'https://test.local/cancel',
};

/** Comfortably past the orphan grace window. */
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');

describe('billing-reconciliation', () => {
  let moduleRef: TestingModule;
  let provisioning: ProvisioningService;
  let lifecycle: SubscriptionLifecycleService;
  let credits: CreditsService;
  let creditReset: CreditResetJob;
  let orphanCleanup: OrphanCleanupJob;
  let repair: LiveSubscriptionRepairJob;
  let drift: DriftDetectionJob;
  let provider: FakeBillingProvider;
  let clock: FixedClock;
  let productId: string;
  let userId: string;

  beforeAll(async () => {
    provider = new FakeBillingProvider();
    clock = new FixedClock(new Date());

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
        CreditResetJob,
        OrphanCleanupJob,
        LiveSubscriptionRepairJob,
        DriftDetectionJob,
        { provide: BILLING_PROVIDER, useValue: provider },
        { provide: CLOCK, useValue: clock },
      ],
    }).compile();
    await moduleRef.init();

    provisioning = moduleRef.get(ProvisioningService);
    lifecycle = moduleRef.get(SubscriptionLifecycleService);
    credits = moduleRef.get(CreditsService);
    creditReset = moduleRef.get(CreditResetJob);
    orphanCleanup = moduleRef.get(OrphanCleanupJob);
    repair = moduleRef.get(LiveSubscriptionRepairJob);
    drift = moduleRef.get(DriftDetectionJob);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    provider.reset();
    provider.priceIntervals.set(PRO_ANNUAL_PRICE, 'year');
    clock.set(new Date());

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

  /** Ends a Pro subscription the way the provider would, and transitions. */
  async function endProAtProvider(
    subscription: SubscriptionModel,
  ): Promise<void> {
    const ended = await provider.cancelSubscriptionNow(
      subscription.providerSubscriptionId,
    );
    await lifecycle.transitionProToFree({
      subscriptionId: subscription.id,
      providerState: ended,
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

  function grantsOf(subscriptionId: string) {
    return testDatabase.prisma.creditGrant.findMany({
      where: { subscriptionId },
      orderBy: { creditPeriodStart: 'asc' },
    });
  }

  function reload(subscriptionId: string): Promise<SubscriptionModel> {
    return testDatabase.prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
  }

  /** A second job instance on its own connection, as a second process would be. */
  function secondCreditResetJob(): CreditResetJob {
    const otherPrisma = testDatabase.newPrismaClient() as PrismaService;
    return new CreditResetJob(
      otherPrisma,
      new CreditsService(otherPrisma, new CreditRepository(otherPrisma)),
      clock,
    );
  }

  // =========================================================================
  // Requirement: Orphaned Provider Subscriptions Are Reconciled
  // =========================================================================
  describe('Requirement: Orphaned Provider Subscriptions Are Reconciled', () => {
    /**
     * Leaves exactly the state design R3 accepts: the local row is terminal and
     * the provider subscription that backed it is still in force, because the
     * post-commit cancellation failed.
     */
    async function orphanedFreeSubscription(): Promise<string> {
      const free = await provisionFree();
      provider.failNext(
        'cancelSubscriptionNow',
        new Error('network died after commit'),
      );
      await upgradeToPro();

      const stranded = provider.subscriptions.get(free.providerSubscriptionId)!;
      expect(stranded.status).toBe(SubscriptionStatus.ACTIVE);
      return free.providerSubscriptionId;
    }

    it('Superseded free subscription was not cancelled', async () => {
      const orphanId = await orphanedFreeSubscription();
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      const livePro = live[0];

      await orphanCleanup.run();

      expect(provider.subscriptions.get(orphanId)!.status).toBe(
        SubscriptionStatus.CANCELED,
      );

      // The live paid subscription is unaffected, locally and at the provider.
      expect(
        provider.subscriptions.get(livePro.providerSubscriptionId)!.status,
      ).toBe(SubscriptionStatus.ACTIVE);
      expect((await reload(livePro.id)).status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('Reconciliation is safe to run repeatedly', async () => {
      const orphanId = await orphanedFreeSubscription();

      const first = await orphanCleanup.run();
      expect(first.cancelled).toEqual([orphanId]);

      const cancelCallsAfterFirst = provider.callsTo(
        'cancelSubscriptionNow',
      ).length;

      const second = await orphanCleanup.run();

      expect(second.cancelled).toEqual([]);
      expect(second.failed).toBe(0);
      // No second cancellation was even attempted.
      expect(provider.callsTo('cancelSubscriptionNow')).toHaveLength(
        cancelCallsAfterFirst,
      );
    });

    it("Reconciliation never cancels a live subscription's provider counterpart", async () => {
      const free = await provisionFree();

      const report = await orphanCleanup.run();

      expect(report.cancelled).toEqual([]);
      expect(
        provider.subscriptions.get(free.providerSubscriptionId)!.status,
      ).toBe(SubscriptionStatus.ACTIVE);
      expect((await reload(free.id)).status).toBe(SubscriptionStatus.ACTIVE);
    });

    it('leaves a paid subscription whose local row has not arrived yet', async () => {
      // Not a spec scenario but the failure mode the grace window exists for: a
      // checkout has completed at the provider and `invoice.paid` has not yet
      // written the row. Cancelling here would destroy a subscription the user
      // just paid for.
      const checkout = await lifecycle.createProCheckout({
        userId,
        productId,
        billingInterval: BillingInterval.MONTH,
        ...CHECKOUT_URLS,
      });
      const paid = provider.completeCheckout(checkout.checkoutSessionId);

      const report = await orphanCleanup.run();

      expect(report.cancelled).toEqual([]);
      expect(report.deferred).toBe(1);
      expect(provider.subscriptions.get(paid.id)!.status).toBe(
        SubscriptionStatus.ACTIVE,
      );
    });

    it('cancels a provider subscription with no local row once it is old enough', async () => {
      await provisionFree();
      const customerId = provider.callsTo('createSubscription').length
        ? (
            provider.calls.find((c) => c.method === 'createSubscription')!
              .argument as { customerId: string }
          ).customerId
        : '';

      provider.createdAt = LONG_AGO;
      const stray = await provider.createSubscription({
        customerId,
        priceId: PRICE_IDS.STRIPE_PRICE_AI_PRO_MONTHLY,
      });
      provider.createdAt = undefined;

      const report = await orphanCleanup.run();

      expect(report.cancelled).toEqual([stray.id]);
      expect(provider.subscriptions.get(stray.id)!.status).toBe(
        SubscriptionStatus.CANCELED,
      );
    });
  });

  // =========================================================================
  // Requirement: Missing Live Subscription Is Reconciled
  // =========================================================================
  describe('Requirement: Missing Live Subscription Is Reconciled', () => {
    /**
     * Strands a user: their Pro row leaves the live set and the replacement
     * Free row is never written, which is what a transition failing partway
     * leaves behind.
     */
    async function strandedUser(): Promise<SubscriptionModel> {
      const pro = await freeThenPro();
      const ended = await provider.cancelSubscriptionNow(
        pro.providerSubscriptionId,
      );
      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: { status: ended.status },
      });
      expect(await liveSubscriptions()).toHaveLength(0);
      return pro;
    }

    it('User left with no live subscription', async () => {
      await strandedUser();

      await repair.run();

      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].plan.isPaid).toBe(false);
    });

    it('Reconciliation does not duplicate an existing live row', async () => {
      const free = await provisionFree();

      const report = await repair.run();

      expect(report.found).toBe(0);
      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(free.id);
    });

    it('Reconciliation respects the terminal rule', async () => {
      const pro = await strandedUser();

      await repair.run();

      const live = await liveSubscriptions();
      expect(live).toHaveLength(1);
      // A new row, not the terminal one brought back.
      expect(live[0].id).not.toBe(pro.id);
      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.CANCELED);
      expect(live[0].providerSubscriptionId).not.toBe(
        pro.providerSubscriptionId,
      );
    });

    it('Repaired Free subscription allocates through the standing path', async () => {
      await strandedUser();

      await repair.run();
      const repaired = (await liveSubscriptions())[0];

      // The repair job itself writes no grant.
      expect(await grantsOf(repaired.id)).toHaveLength(0);

      // The credits arrive when the new subscription's first credit period is
      // allocated by the ordinary routine — the same one every other Free
      // subscription's `$0 invoice.paid` writes through.
      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: repaired.planId },
      });
      const policy = creditPolicyOf(plan);
      const period = creditPeriodFrom(
        repaired.currentPeriodStart ?? new Date(),
        policy,
      );
      await credits.allocateSubscriptionCredits({
        userId,
        productId,
        subscriptionId: repaired.id,
        creditPeriodStart: period.start,
        creditPeriodEnd: period.end,
        amount: policy.creditsPerPeriod,
      });

      const grants = await grantsOf(repaired.id);
      expect(grants).toHaveLength(1);
      expect(grants[0].amountRemaining).toBe(50);
    });

    it('Repair does not resurrect expired Pro credits', async () => {
      const pro = await freeThenPro();

      // Buy an add-on, so the frozen-not-expired half is observable too.
      const purchase = await testDatabase.prisma.addonPurchase.create({
        data: {
          userId,
          productId,
          addonPackageId: (
            await testDatabase.prisma.addonPackage.findFirstOrThrow({
              where: { productId },
            })
          ).id,
        },
      });
      await credits.grantAddonCredits({
        userId,
        productId,
        addonPurchaseId: purchase.id,
        amount: 500,
      });

      // Pro's credits expire when Pro departs (design D4b).
      await endProAtProvider(pro);
      const proGrants = await grantsOf(pro.id);
      expect(proGrants.every((g) => g.amountRemaining === 0)).toBe(true);

      // Strand the user by removing the Free row the transition created.
      const replacement = (await liveSubscriptions())[0];
      await testDatabase.prisma.subscription.update({
        where: { id: replacement.id },
        data: { status: SubscriptionStatus.CANCELED },
      });

      await repair.run();

      // Still expired. Repair restores entitlement, not history.
      expect(
        (await grantsOf(pro.id)).every((g) => g.amountRemaining === 0),
      ).toBe(true);

      const repaired = (await liveSubscriptions())[0];
      const balance = await credits.getBalance(
        userId,
        productId,
        toEntitlementState({ status: repaired.status, isPaidPlan: false }),
      );
      // The add-on's 500 are preserved and frozen — not expired, not spendable.
      expect(balance.frozen).toBe(500);
      expect(balance.spendable).toBe(0);
    });
  });

  // =========================================================================
  // Requirement: Local State Drift From Stripe Is Detected
  // =========================================================================
  describe('Requirement: Local State Drift From Stripe Is Detected', () => {
    it('Status drift is surfaced', async () => {
      const free = await provisionFree();

      // Stripe says canceled; the local row still says live, as it would if the
      // deletion webhook were never delivered.
      const atProvider = provider.subscriptions.get(
        free.providerSubscriptionId,
      )!;
      provider.subscriptions.set(free.providerSubscriptionId, {
        ...atProvider,
        status: SubscriptionStatus.CANCELED,
      });

      const report = await drift.run();

      expect(report.examined).toBe(1);
      expect(report.divergences).toContainEqual(
        expect.objectContaining({
          subscriptionId: free.id,
          kind: 'status',
          local: SubscriptionStatus.ACTIVE,
          atProvider: SubscriptionStatus.CANCELED,
        }),
      );
    });

    it('Drift detection makes no Stripe mutations', async () => {
      await provisionFree();
      const before = provider.calls.length;

      await drift.run();

      const during = provider.calls.slice(before);
      expect(during.length).toBeGreaterThan(0);
      expect(during.every((c) => c.method === 'getSubscription')).toBe(true);
    });

    it('reports a subscription the provider no longer has', async () => {
      const free = await provisionFree();
      provider.subscriptions.delete(free.providerSubscriptionId);

      const report = await drift.run();

      expect(report.divergences).toContainEqual(
        expect.objectContaining({
          subscriptionId: free.id,
          kind: 'missing-at-provider',
        }),
      );
    });

    it('reports nothing when local state tracks the provider', async () => {
      await provisionFree();

      const report = await drift.run();

      expect(report.divergences).toEqual([]);
      expect(report.unreadable).toBe(0);
    });
  });

  // =========================================================================
  // Requirement: Scheduled Credit Reset Is Required
  // =========================================================================
  describe('Requirement: Scheduled Credit Reset Is Required', () => {
    /** A Pro Annual subscription with its one annual invoice already paid. */
    async function proAnnual(): Promise<SubscriptionModel> {
      return freeThenPro(userId, BillingInterval.YEAR);
    }

    it('Reset falls due between invoices', async () => {
      const pro = await proAnnual();
      const first = await grantsOf(pro.id);
      expect(first).toHaveLength(1);

      // Spend some of month one, so "unspent credits expire" has something to
      // bite on and the new period is visibly fresh rather than merely equal.
      await credits.consume({
        userId,
        productId,
        requestId: randomUUID(),
        amount: 30,
        entitlement: toEntitlementState({
          status: pro.status,
          isPaidPlan: true,
        }),
      });

      clock.set(new Date((await reload(pro.id)).nextCreditResetAt!));
      const providerCallsBefore = provider.calls.length;
      const report = await creditReset.run();

      expect(report.granted).toBe(1);

      // No invoice was generated, and nothing at the provider was touched at
      // all: the job is purely local, which is what "between invoices" means.
      expect(provider.calls).toHaveLength(providerCallsBefore);

      const grants = await grantsOf(pro.id);
      expect(grants).toHaveLength(2);
      // The previous period's unspent credit expired rather than rolling over.
      expect(grants[0].amountRemaining).toBe(0);
      expect(grants[1].amountRemaining).toBe(100);

      const expiries = await testDatabase.prisma.creditTransaction.count({
        where: {
          creditGrantId: grants[0].id,
          type: CreditTransactionType.EXPIRY,
        },
      });
      expect(expiries).toBe(1);
    });

    it('A full annual year is covered', async () => {
      const pro = await proAnnual();

      // Twelve credit periods across one paid year. Eleven resets, because the
      // invoice already produced month one.
      let resetsRun = 0;
      for (let month = 1; month < 12; month += 1) {
        clock.set(new Date((await reload(pro.id)).nextCreditResetAt!));
        const report = await creditReset.run();
        resetsRun += report.granted;
      }

      const grants = await grantsOf(pro.id);
      expect(grants).toHaveLength(12);
      expect(resetsRun).toBe(11);

      // No month skipped and none doubled: each period starts exactly where the
      // previous one ended.
      for (let i = 1; i < grants.length; i += 1) {
        expect(grants[i].creditPeriodStart!.getTime()).toBe(
          grants[i - 1].creditPeriodEnd!.getTime(),
        );
      }
      expect(
        new Set(grants.map((g) => g.creditPeriodStart!.getTime())).size,
      ).toBe(12);

      // Only the final period is still spendable.
      expect(grants.slice(0, 11).every((g) => g.amountRemaining === 0)).toBe(
        true,
      );
      expect(grants[11].amountRemaining).toBe(100);

      // Still one annual invoice's worth of billing — the job generated none.
      expect(provider.callsTo('changeSubscriptionPrice')).toHaveLength(0);
    });

    it('Reset runs on more than one instance', async () => {
      const pro = await proAnnual();
      clock.set(new Date((await reload(pro.id)).nextCreditResetAt!));

      const other = secondCreditResetJob();
      const [a, b] = await Promise.all([creditReset.run(), other.run()]);

      // Exactly one fresh grant, however the race resolved.
      expect(a.granted + b.granted).toBe(1);
      expect(a.failed + b.failed).toBe(0);
      expect(await grantsOf(pro.id)).toHaveLength(2);
    });

    it('No double allocation with invoice-driven grants', async () => {
      const pro = await proAnnual();
      const subscription = await reload(pro.id);
      const plan = await testDatabase.prisma.plan.findUniqueOrThrow({
        where: { id: subscription.planId },
      });
      const policy = creditPolicyOf(plan);

      // The first month of the paid year: the invoice has already allocated it.
      // Rewind the marker so the job believes the same period is still due.
      const firstGrant = (await grantsOf(pro.id))[0];
      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: { nextCreditResetAt: firstGrant.creditPeriodStart },
      });
      clock.set(new Date(firstGrant.creditPeriodStart!.getTime() + 1000));

      const report = await creditReset.run();

      // The unique index on (subscription, credit period start) is what decides
      // it — the job found the invoice's grant already there.
      expect(report.granted).toBe(0);
      expect(report.alreadyAllocated).toBe(1);

      const grants = await grantsOf(pro.id);
      expect(grants).toHaveLength(1);
      expect(grants[0].amountRemaining).toBe(policy.creditsPerPeriod);
    });

    it('Reset advances its marker only on success', async () => {
      const pro = await proAnnual();
      const before = await reload(pro.id);

      // Not yet due: nothing happens and the marker is untouched.
      const untouched = await creditReset.run();
      expect(untouched.due).toBe(0);
      expect((await reload(pro.id)).nextCreditResetAt!.getTime()).toBe(
        before.nextCreditResetAt!.getTime(),
      );

      // Due: the marker advances in the transaction that created the grant.
      clock.set(new Date(before.nextCreditResetAt!));
      await creditReset.run();

      const after = await reload(pro.id);
      const grants = await grantsOf(pro.id);
      expect(after.nextCreditResetAt!.getTime()).toBe(
        grants[1].creditPeriodEnd!.getTime(),
      );
      expect(after.nextCreditResetAt!.getTime()).toBeGreaterThan(
        before.nextCreditResetAt!.getTime(),
      );
    });

    it('Frozen subscriptions do not accrue resets that bypass freeze', async () => {
      const pro = await proAnnual();

      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: { status: SubscriptionStatus.PAST_DUE },
      });

      clock.set(new Date((await reload(pro.id)).nextCreditResetAt!));
      const report = await creditReset.run();

      // PAST_DUE is live, so the reset still happens — no special case in the
      // job. The grant it creates is simply unspendable while the freeze holds.
      expect(report.granted).toBe(1);

      const balance = await credits.getBalance(
        userId,
        productId,
        toEntitlementState({
          status: SubscriptionStatus.PAST_DUE,
          isPaidPlan: true,
        }),
      );
      expect(balance.spendable).toBe(0);
      expect(balance.frozen).toBe(100);
    });

    it('Reset skips subscriptions that are not live', async () => {
      const pro = await proAnnual();
      const due = (await reload(pro.id)).nextCreditResetAt!;

      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: { status: SubscriptionStatus.CANCELED },
      });
      clock.set(new Date(due));

      const report = await creditReset.run();

      expect(report.due).toBe(0);
      expect(report.granted).toBe(0);
      expect(await grantsOf(pro.id)).toHaveLength(1);
    });
  });

  // =========================================================================
  // Requirement: Scheduled Jobs Are Idempotent And Concurrency Safe
  // =========================================================================
  describe('Requirement: Scheduled Jobs Are Idempotent And Concurrency Safe', () => {
    it('Two instances run the same job at once', async () => {
      const pro = await freeThenPro(userId, BillingInterval.YEAR);
      clock.set(new Date((await reload(pro.id)).nextCreditResetAt!));

      const other = secondCreditResetJob();
      await Promise.all([creditReset.run(), other.run()]);

      // Identical to what one run leaves behind: the period that ended is
      // expired, the new one holds a full allocation, and there is exactly one
      // grant per period rather than two for the contested one.
      const grants = await grantsOf(pro.id);
      expect(grants).toHaveLength(2);
      expect(grants[0].amountRemaining).toBe(0);
      expect(grants[1].amountRemaining).toBe(100);
      expect(
        new Set(grants.map((g) => g.creditPeriodStart!.getTime())).size,
      ).toBe(2);

      // And the marker moved once, not twice.
      expect((await reload(pro.id)).nextCreditResetAt!.getTime()).toBe(
        grants[1].creditPeriodEnd!.getTime(),
      );
    });

    it('repair is safe under two instances', async () => {
      const pro = await freeThenPro();
      const ended = await provider.cancelSubscriptionNow(
        pro.providerSubscriptionId,
      );
      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: { status: ended.status },
      });

      const otherPrisma = testDatabase.newPrismaClient() as PrismaService;
      const other = new LiveSubscriptionRepairJob(otherPrisma, provisioning);

      await Promise.all([repair.run(), other.run()]);

      // The one-live-row index arbitrates; the loser yields rather than errors.
      expect(await liveSubscriptions()).toHaveLength(1);
    });

    it('orphan cleanup is safe under two instances', async () => {
      const free = await provisionFree();
      provider.failNext(
        'cancelSubscriptionNow',
        new Error('network died after commit'),
      );
      await upgradeToPro();

      const otherPrisma = testDatabase.newPrismaClient() as PrismaService;
      const other = new OrphanCleanupJob(otherPrisma, provider, clock);

      await Promise.all([orphanCleanup.run(), other.run()]);

      expect(
        provider.subscriptions.get(free.providerSubscriptionId)!.status,
      ).toBe(SubscriptionStatus.CANCELED);
      expect(await liveSubscriptions()).toHaveLength(1);
    });

    it('every job is a no-op on an already-reconciled system', async () => {
      await freeThenPro();

      const first = await Promise.all([
        creditReset.run(),
        orphanCleanup.run(),
        repair.run(),
        drift.run(),
      ]);
      const second = await Promise.all([
        creditReset.run(),
        orphanCleanup.run(),
        repair.run(),
        drift.run(),
      ]);

      expect(first[0].granted).toBe(0);
      expect(second[0].granted).toBe(0);
      expect(second[1].cancelled).toEqual([]);
      expect(second[2].repaired).toBe(0);
      expect(second[3].divergences).toEqual([]);
    });
  });

  // =========================================================================
  // Requirement: No Scheduled Job Retries A Payment
  // =========================================================================
  describe('Requirement: No Scheduled Job Retries A Payment', () => {
    it('no job pays, retries, or cancels on a timer', async () => {
      const pro = await freeThenPro();
      await testDatabase.prisma.subscription.update({
        where: { id: pro.id },
        data: {
          status: SubscriptionStatus.PAST_DUE,
          paymentAttemptCount: 2,
          nextPaymentAttemptAt: new Date(Date.now() - 86_400_000),
        },
      });

      const paymentsBefore = await testDatabase.prisma.payment.count();
      const before = provider.calls.length;

      // Everything a past-due subscription might tempt a job into doing.
      await creditReset.run();
      await orphanCleanup.run();
      await repair.run();
      await drift.run();

      // No payment was recorded and the subscription was not cancelled.
      expect(await testDatabase.prisma.payment.count()).toBe(paymentsBefore);
      expect((await reload(pro.id)).status).toBe(SubscriptionStatus.PAST_DUE);

      const during = provider.calls.slice(before);
      expect(
        during.filter((c) => c.method === 'cancelSubscriptionNow'),
      ).toEqual([]);
      expect(
        during.filter((c) => c.method === 'cancelSubscriptionAtPeriodEnd'),
      ).toEqual([]);
    });
  });
});
