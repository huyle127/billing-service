import request from 'supertest';
import {
  AddonPurchaseStatus,
  BillingInterval,
  CreditGrantSource,
} from '../../src/generated/prisma/enums';
import { ApiHarness, CHECKOUT_URLS } from './api-harness';
import type { RegisteredUser } from './api-harness';
import { testDatabase } from './test-database';

/**
 * Add-on fulfilment, driven through the webhook endpoint.
 *
 * This suite exists because of a specific defect: `fulfilPurchase` had no
 * caller in `src/`, `checkout.session.completed` was not a handled event, and a
 * paid add-on therefore granted nothing. The full integration suite was green
 * throughout, because its add-on tests call `fulfilPurchase` directly and so
 * exercise the routine while bypassing the wiring that was missing.
 *
 * Every test here goes through the HTTP endpoint. A test that called the
 * service would reproduce the blind spot rather than close it
 * (`addon-purchase` → "Confirmation arrives as a webhook delivery").
 */

const harness = new ApiHarness();

describe('add-on fulfilment', () => {
  let productId: string;
  let user: RegisteredUser;

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.provider.reset();
    productId = await harness.seedCatalog();
    user = await harness.register();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function postWebhook(delivery: {
    payload: Buffer;
    signature: string;
  }): Promise<request.Response> {
    return request(harness.server)
      .post('/webhooks/stripe')
      .set('stripe-signature', delivery.signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'));
  }

  /** An add-on needs a live paid subscription, so Pro comes first. */
  async function upgradeToPro(): Promise<void> {
    const checkout = await harness
      .post('/subscriptions', user)
      .send({ billingInterval: BillingInterval.MONTH, ...CHECKOUT_URLS })
      .expect(201);

    const { checkoutSessionId } = checkout.body as {
      checkoutSessionId: string;
    };
    const atProvider = harness.provider.completeCheckout(checkoutSessionId);

    await postWebhook(
      harness.provider.deliver('invoice.paid', {
        kind: 'invoice-paid',
        invoice: harness.provider.invoiceFor(atProvider.id, {
          amountPaid: 2000,
          amountDue: 2000,
        }),
      }),
    ).then((response) => expect(response.status).toBe(200));
  }

  async function startAddonPurchase(): Promise<string> {
    const response = await harness
      .post('/addons', user)
      .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
      .expect(201);

    return (response.body as { checkoutSessionId: string }).checkoutSessionId;
  }

  function addonGrants() {
    return testDatabase.prisma.creditGrant.findMany({
      where: { userId: user.id, productId, source: CreditGrantSource.ADDON },
    });
  }

  // ==========================================================================
  describe('Requirement: Add-On Credits Are Granted Only After Successful Payment', () => {
    it('Confirmation arrives as a webhook delivery', async () => {
      await upgradeToPro();
      const sessionId = await startAddonPurchase();

      // Nothing yet: starting a checkout confers no entitlement.
      expect(await addonGrants()).toHaveLength(0);

      const response = await postWebhook(
        harness.provider.payOneTimeCheckout(sessionId, { amountTotal: 1000 }),
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'processed' });

      const grants = await addonGrants();
      expect(grants).toHaveLength(1);
      // From the catalogued SKU, not the amount paid.
      expect(grants[0].amountInitial).toBe(100);

      const purchase = await testDatabase.prisma.addonPurchase.findFirstOrThrow(
        { where: { providerCheckoutSessionId: sessionId } },
      );
      expect(purchase.status).toBe(AddonPurchaseStatus.COMPLETED);

      const payment = await testDatabase.prisma.payment.findFirstOrThrow({
        where: { addonPurchaseId: purchase.id },
      });
      expect(payment.amount).toBe(1000);
    });

    it('the granted credit is spendable through the API', async () => {
      await upgradeToPro();
      const sessionId = await startAddonPurchase();

      const before = await harness.get('/credits/balance', user).expect(200);
      const spendableBefore = (before.body as { spendable: number }).spendable;

      await postWebhook(harness.provider.payOneTimeCheckout(sessionId));

      const after = await harness.get('/credits/balance', user).expect(200);
      expect((after.body as { spendable: number }).spendable).toBe(
        spendableBefore + 100,
      );
    });

    it('Duplicate add-on payment event', async () => {
      await upgradeToPro();
      const sessionId = await startAddonPurchase();

      const delivery = harness.provider.payOneTimeCheckout(sessionId);
      await postWebhook(delivery);

      const replay = await postWebhook(harness.provider.redeliver(delivery));
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ outcome: 'duplicate' });

      expect(await addonGrants()).toHaveLength(1);
      expect(
        await testDatabase.prisma.payment.count({
          where: { userId: user.id, addonPurchaseId: { not: null } },
        }),
      ).toBe(1);
    });

    it('a completed checkout this service never started is ignored', async () => {
      // Another integration on the same provider account, or a subscription
      // checkout that reached this handler. Neither is an error.
      harness.provider.checkoutSessions.set('cs_not_ours', {
        id: 'cs_not_ours',
        url: null,
      });

      const response = await postWebhook(
        harness.provider.payOneTimeCheckout('cs_not_ours'),
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'ignored' });
      expect(await addonGrants()).toHaveLength(0);
    });

    it('a paid session with no payment intent grants nothing', async () => {
      await upgradeToPro();
      const sessionId = await startAddonPurchase();

      const response = await postWebhook(
        harness.provider.payOneTimeCheckout(sessionId, {
          paymentIntentId: null,
        }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'ignored' });
      expect(await addonGrants()).toHaveLength(0);

      // Left pending for inspection rather than completed against a
      // fabricated payment identifier.
      const purchase = await testDatabase.prisma.addonPurchase.findFirstOrThrow(
        { where: { providerCheckoutSessionId: sessionId } },
      );
      expect(purchase.status).toBe(AddonPurchaseStatus.PENDING);
    });
  });

  // ==========================================================================
  describe('Requirement: A Repeated Attempt At A Provider Write Is Not A Second Operation', () => {
    it('A caller declares a repeated attempt', async () => {
      await upgradeToPro();

      const first = await harness
        .post('/addons', user)
        .set('Idempotency-Key', 'attempt-one')
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(201);

      const second = await harness
        .post('/addons', user)
        .set('Idempotency-Key', 'attempt-one')
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(201);

      expect(
        (second.body as { checkoutSessionId: string }).checkoutSessionId,
      ).toBe((first.body as { checkoutSessionId: string }).checkoutSessionId);
    });

    it('A distinct attempt is not suppressed', async () => {
      await upgradeToPro();

      const first = await harness
        .post('/addons', user)
        .set('Idempotency-Key', 'attempt-one')
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(201);

      const second = await harness
        .post('/addons', user)
        .set('Idempotency-Key', 'attempt-two')
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(201);

      expect(
        (second.body as { checkoutSessionId: string }).checkoutSessionId,
      ).not.toBe(
        (first.body as { checkoutSessionId: string }).checkoutSessionId,
      );
    });
  });
});
