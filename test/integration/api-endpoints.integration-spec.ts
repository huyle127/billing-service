import request from 'supertest';
import { CHECKOUT_URLS, ApiHarness, PRICE_IDS } from './api-harness';
import type { RegisteredUser } from './api-harness';
import { BillingInterval } from '../../src/generated/prisma/enums';
import { stringContaining, stringMatching } from './matchers';
import { testDatabase } from './test-database';

/**
 * The billing API, asserted against `specs/api-endpoints/spec.md`. Scenario
 * names are verbatim.
 *
 * Every test drives the service the way a client does: register, take the
 * token, call the endpoint. Provider-side events are played by the fake
 * provider, because a checkout has no local effect until payment is confirmed.
 */

const harness = new ApiHarness();

describe('the billing API', () => {
  let user: RegisteredUser;
  let productId: string;

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.provider.reset();
    harness.provider.priceIntervals.set(
      PRICE_IDS.STRIPE_PRICE_AI_PRO_ANNUAL,
      'year',
    );
    productId = await harness.seedCatalog();
    user = await harness.register();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Buys Pro and lets the provider report the first invoice paid. */
  async function upgradeToPro(
    as: RegisteredUser = user,
    billingInterval: BillingInterval = BillingInterval.MONTH,
  ): Promise<string> {
    const checkout = await harness
      .post('/subscriptions', as)
      .send({ billingInterval, ...CHECKOUT_URLS })
      .expect(201);

    const { checkoutSessionId } = checkout.body as {
      checkoutSessionId: string;
    };
    const atProvider = harness.provider.completeCheckout(checkoutSessionId);

    await deliverInvoicePaid(atProvider.id, 2000);

    const row = await testDatabase.prisma.subscription.findUniqueOrThrow({
      where: { providerSubscriptionId: atProvider.id },
    });
    return row.id;
  }

  async function deliverInvoicePaid(
    providerSubscriptionId: string,
    amount: number,
  ): Promise<void> {
    const delivery = harness.provider.deliver('invoice.paid', {
      kind: 'invoice-paid',
      invoice: harness.provider.invoiceFor(providerSubscriptionId, {
        amountPaid: amount,
        amountDue: amount,
      }),
    });

    await request(harness.server)
      .post('/webhooks/stripe')
      .set('stripe-signature', delivery.signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'))
      .expect(200);
  }

  /** The Free subscription registration provisioned. */
  async function freeSubscriptionId(
    as: RegisteredUser = user,
  ): Promise<string> {
    const row = await testDatabase.prisma.subscription.findFirstOrThrow({
      where: { userId: as.id, productId },
      orderBy: { createdAt: 'asc' },
    });
    return row.id;
  }

  // ==========================================================================
  describe('Requirement: Customer Endpoint', () => {
    it('Customer info retrieved', async () => {
      const response = await harness.get('/customer', user).expect(200);

      expect(response.body).toMatchObject({
        userId: user.id,
        email: user.email,
      });
      expect(
        (response.body as { stripeCustomerId: string }).stripeCustomerId,
      ).toMatch(/^cus_/);
    });

    it('No Stripe customer', async () => {
      // A user whose customer was never created — registration's provisioning
      // is best-effort, so this state is reachable.
      await testDatabase.prisma.subscription.deleteMany({
        where: { userId: user.id },
      });
      await testDatabase.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: null },
      });

      const response = await harness.get('/customer', user).expect(200);

      const { stripeCustomerId } = response.body as {
        stripeCustomerId: string;
      };
      expect(stripeCustomerId).toMatch(/^cus_/);
      expect(harness.provider.customers.has(stripeCustomerId)).toBe(true);
    });
  });

  // ==========================================================================
  describe('Requirement: Subscription Endpoints', () => {
    it('List subscriptions', async () => {
      const free = await freeSubscriptionId();
      const pro = await upgradeToPro();

      const response = await harness.get('/subscriptions', user).expect(200);

      const listed = response.body as { id: string; isLive: boolean }[];
      expect(listed.map((entry) => entry.id)).toEqual([free, pro]);
      // The superseded Free row is terminal and still reported.
      expect(listed[0].isLive).toBe(false);
      expect(listed[1].isLive).toBe(true);
    });

    it('Current subscription', async () => {
      const pro = await upgradeToPro();

      const response = await harness
        .get('/subscriptions/current', user)
        .expect(200);

      expect(response.body).toMatchObject({
        id: pro,
        planKey: 'pro',
        isPaidPlan: true,
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
      });
    });

    it('Subscribe or upgrade', async () => {
      const response = await harness
        .post('/subscriptions', user)
        .send({ billingInterval: BillingInterval.MONTH, ...CHECKOUT_URLS })
        .expect(201);

      expect(response.body).toMatchObject({
        checkoutSessionId: stringMatching(/^cs_/),
        url: stringContaining('https://checkout.test/'),
      });
      // A checkout is not a billing event: no paid subscription yet.
      const live = await harness.get('/subscriptions/current', user);
      expect(live.body).toMatchObject({ planKey: 'free' });
    });

    it('Change cycle', async () => {
      const pro = await upgradeToPro();

      const response = await harness
        .patch(`/subscriptions/${pro}/cycle`, user)
        .send({ billingInterval: BillingInterval.YEAR })
        .expect(200);

      expect(response.body).toMatchObject({
        id: pro,
        billingInterval: 'YEAR',
      });
      // Same provider subscription throughout: a cycle change is a price
      // change, never a new subscription.
      const row = await testDatabase.prisma.subscription.findUniqueOrThrow({
        where: { id: pro },
      });
      expect(response.body).toMatchObject({
        providerSubscriptionId: row.providerSubscriptionId,
      });
      expect(
        harness.provider.subscriptions.get(row.providerSubscriptionId)?.priceId,
      ).toBe(PRICE_IDS.STRIPE_PRICE_AI_PRO_ANNUAL);
    });

    it('Cancel at period end', async () => {
      const pro = await upgradeToPro();

      const response = await harness
        .post(`/subscriptions/${pro}/cancel`, user)
        .expect(200);

      expect(response.body).toMatchObject({
        id: pro,
        cancelAtPeriodEnd: true,
        // Still live, still Pro: the user keeps what they paid for.
        isLive: true,
        planKey: 'pro',
      });
    });

    it('Cancel immediately', async () => {
      const pro = await upgradeToPro();

      const response = await harness
        .post(`/subscriptions/${pro}/cancel-now`, user)
        .expect(200);

      // The response is the Free subscription the user now holds.
      expect(response.body).toMatchObject({ planKey: 'free', isLive: true });
      const cancelled =
        await testDatabase.prisma.subscription.findUniqueOrThrow({
          where: { id: pro },
        });
      expect(cancelled.status).toBe('CANCELED');
    });

    it('Reactivate', async () => {
      const pro = await upgradeToPro();
      await harness.post(`/subscriptions/${pro}/cancel`, user).expect(200);

      const response = await harness
        .post(`/subscriptions/${pro}/reactivate`, user)
        .expect(200);

      expect(response.body).toMatchObject({
        id: pro,
        cancelAtPeriodEnd: false,
        isLive: true,
      });
    });

    it('refuses a subscription belonging to another user', async () => {
      const pro = await upgradeToPro();
      const stranger = await harness.register();

      const response = await harness
        .post(`/subscriptions/${pro}/cancel`, stranger)
        .expect(404);

      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      const row = await testDatabase.prisma.subscription.findUniqueOrThrow({
        where: { id: pro },
      });
      expect(row.cancelAtPeriodEnd).toBe(false);
    });
  });

  // ==========================================================================
  describe('Requirement: Add-on Purchase Endpoint', () => {
    it('Purchase add-on', async () => {
      await upgradeToPro();

      const response = await harness
        .post('/addons', user)
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(201);

      expect(response.body).toMatchObject({
        creditAmount: 100,
        checkoutSessionId: stringMatching(/^cs_/),
      });
      // No credit yet: a checkout grants nothing.
      const balance = await harness.get('/credits/balance', user);
      expect(balance.body).toMatchObject({ spendable: 100 });
    });

    it('Free user rejected', async () => {
      const response = await harness
        .post('/addons', user)
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(409);

      expect(response.body).toMatchObject({
        code: 'INVALID_SUBSCRIPTION_STATE',
      });
      // Refused before any provider call: nothing to abandon.
      expect(harness.provider.callsTo('createCheckoutSession')).toHaveLength(0);
      expect(await testDatabase.prisma.addonPurchase.count()).toBe(0);
    });
  });

  // ==========================================================================
  describe('Requirement: Credit Endpoints', () => {
    it('Get balance', async () => {
      // Free's credits arrive with its own $0 invoice.
      const free = await testDatabase.prisma.subscription.findFirstOrThrow({
        where: { userId: user.id },
      });
      await deliverInvoicePaid(free.providerSubscriptionId, 0);

      const response = await harness.get('/credits/balance', user).expect(200);

      expect(response.body).toMatchObject({
        spendable: 50,
        frozen: 0,
        total: 50,
        freezeReason: null,
      });
    });

    it('Consume credits', async () => {
      await upgradeToPro();

      const response = await harness
        .post('/credits/consume', user)
        .send({ amount: 30, requestId: 'req-1' })
        .expect(200);

      expect(response.body).toMatchObject({ amount: 30, deduplicated: false });
      const after = await harness.get('/credits/balance', user);
      expect(after.body).toMatchObject({ spendable: 70 });
    });

    it('replays a repeated request rather than spending twice', async () => {
      await upgradeToPro();
      await harness
        .post('/credits/consume', user)
        .send({ amount: 30, requestId: 'req-1' })
        .expect(200);

      const replay = await harness
        .post('/credits/consume', user)
        .send({ amount: 30, requestId: 'req-1' })
        .expect(200);

      expect(replay.body).toMatchObject({ deduplicated: true });
      const after = await harness.get('/credits/balance', user);
      expect(after.body).toMatchObject({ spendable: 70 });
    });

    it('Insufficient credits', async () => {
      await upgradeToPro();

      const response = await harness
        .post('/credits/consume', user)
        .send({ amount: 1000 })
        .expect(402);

      expect(response.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
      const after = await harness.get('/credits/balance', user);
      expect(after.body).toMatchObject({ spendable: 100 });
    });

    it('Credit history', async () => {
      await upgradeToPro();
      await harness
        .post('/credits/consume', user)
        .send({ amount: 10, requestId: 'req-1' })
        .expect(200);

      const response = await harness.get('/credits/history', user).expect(200);

      const entries = response.body as { type: string; amount: number }[];
      // Newest first.
      expect(entries[0]).toMatchObject({ type: 'CONSUMPTION', amount: -10 });
      expect(entries.at(-1)).toMatchObject({ type: 'ALLOCATION' });
    });
  });

  // ==========================================================================
  describe('Requirement: History Endpoints', () => {
    it('Payment history', async () => {
      await upgradeToPro();

      const response = await harness.get('/history/payments', user).expect(200);

      const payments = response.body as { amount: number; status: string }[];
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        amount: 2000,
        status: 'SUCCEEDED',
        type: 'SUBSCRIPTION_RECURRING',
      });
    });

    it('Subscription history', async () => {
      const free = await freeSubscriptionId();
      const pro = await upgradeToPro();

      const response = await harness
        .get('/history/subscriptions', user)
        .expect(200);

      const entries = response.body as { id: string }[];
      expect(entries.map((entry) => entry.id)).toEqual([free, pro]);
    });

    it('Credit history', async () => {
      await upgradeToPro();

      const response = await harness.get('/history/credits', user).expect(200);

      const entries = response.body as { type: string; balanceAfter: number }[];
      expect(entries).not.toHaveLength(0);
      expect(entries.at(-1)).toMatchObject({ type: 'ALLOCATION' });
    });
  });

  // ==========================================================================
  describe('registration through to an authenticated billing call', () => {
    it('provisions Free, issues a token, and serves the billing state', async () => {
      const fresh = await harness.register();

      // Registration provisioned Free.
      const provisioned =
        await testDatabase.prisma.subscription.findFirstOrThrow({
          where: { userId: fresh.id },
          include: { plan: true },
        });
      expect(provisioned.plan.isPaid).toBe(false);

      // Logging in again returns a token that works just as well.
      const login = await request(harness.server)
        .post('/auth/login')
        .send({ email: fresh.email, password: fresh.password })
        .expect(200);
      const { accessToken } = login.body as { accessToken: string };

      const current = await request(harness.server)
        .get('/subscriptions/current')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(current.body).toMatchObject({
        id: provisioned.id,
        planKey: 'free',
        isLive: true,
      });
    });
  });

  // ==========================================================================
  describe('every billing endpoint refuses an unauthenticated caller', () => {
    type Method = 'get' | 'post' | 'patch' | 'delete';

    const BILLING_ROUTES: [method: Method, path: string][] = [
      ['get', '/customer'],
      ['get', '/payment-methods'],
      ['post', '/payment-methods'],
      ['delete', '/payment-methods/pm_1'],
      ['patch', '/payment-methods/pm_1/default'],
      ['get', '/subscriptions'],
      ['get', '/subscriptions/current'],
      ['post', '/subscriptions'],
      ['patch', '/subscriptions/00000000-0000-4000-8000-000000000000/cycle'],
      ['post', '/subscriptions/00000000-0000-4000-8000-000000000000/cancel'],
      [
        'post',
        '/subscriptions/00000000-0000-4000-8000-000000000000/cancel-now',
      ],
      [
        'post',
        '/subscriptions/00000000-0000-4000-8000-000000000000/reactivate',
      ],
      ['get', '/addons'],
      ['post', '/addons'],
      ['get', '/credits/balance'],
      ['post', '/credits/consume'],
      ['get', '/credits/history'],
      ['get', '/history/payments'],
      ['get', '/history/subscriptions'],
      ['get', '/history/credits'],
    ];

    it.each(BILLING_ROUTES)('%s %s', async (method, path) => {
      const agent = request(harness.server);
      const pending =
        method === 'get'
          ? agent.get(path)
          : method === 'post'
            ? agent.post(path)
            : method === 'patch'
              ? agent.patch(path)
              : agent.delete(path);

      const response = await pending.send({});

      // The guard runs before validation and before any handler, so a route
      // whose body or path parameter is nonsense still answers this way.
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('leaves the webhook and health endpoints public', async () => {
      await request(harness.server).get('/health').expect(200);

      const delivery = harness.provider.deliver(
        'customer.discount.created',
        null,
      );
      await request(harness.server)
        .post('/webhooks/stripe')
        .set('stripe-signature', delivery.signature)
        .set('content-type', 'application/json')
        .send(delivery.payload.toString('utf8'))
        .expect(200);
    });
  });
});
