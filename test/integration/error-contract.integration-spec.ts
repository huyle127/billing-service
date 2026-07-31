import request from 'supertest';
import { BillingException } from '../../src/common/errors/billing.exception';
import { ErrorCode } from '../../src/common/errors/error-code';
import { BillingInterval } from '../../src/generated/prisma/enums';
import { buildOpenApiDocument } from '../../src/swagger';
import { CHECKOUT_URLS, ApiHarness, PRICE_IDS } from './api-harness';
import type { RegisteredUser } from './api-harness';
import { anyString, arrayContaining, stringContaining } from './matchers';
import { testDatabase } from './test-database';

/**
 * The error contract at the HTTP boundary, asserted against
 * `specs/billing-history/spec.md` in this change. Each of the ten required
 * codes is produced by a real request rather than by constructing an exception.
 */

const harness = new ApiHarness();

describe('the error contract', () => {
  let user: RegisteredUser;

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.provider.reset();
    await harness.seedCatalog();
    user = await harness.register();
  });

  /** Buys Pro and lets the provider report the first invoice paid. */
  async function upgradeToPro(): Promise<string> {
    const checkout = await harness
      .post('/subscriptions', user)
      .send({ billingInterval: BillingInterval.MONTH, ...CHECKOUT_URLS })
      .expect(201);
    const { checkoutSessionId } = checkout.body as {
      checkoutSessionId: string;
    };
    const atProvider = harness.provider.completeCheckout(checkoutSessionId);

    const delivery = harness.provider.deliver('invoice.paid', {
      kind: 'invoice-paid',
      invoice: harness.provider.invoiceFor(atProvider.id, {
        amountPaid: 2000,
        amountDue: 2000,
      }),
    });
    await postWebhook(delivery);

    const row = await testDatabase.prisma.subscription.findUniqueOrThrow({
      where: { providerSubscriptionId: atProvider.id },
    });
    return row.id;
  }

  function postWebhook(
    delivery: { payload: Buffer; signature: string },
    signature = delivery.signature,
  ) {
    return request(harness.server)
      .post('/webhooks/stripe')
      .set('stripe-signature', signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'));
  }

  // ==========================================================================
  describe('Requirement: Error Contract Coverage', () => {
    it('Invalid payment method returned', async () => {
      const response = await harness
        .delete('/payment-methods/pm_never_attached', user)
        .expect(400);

      expect(response.body).toMatchObject({
        code: ErrorCode.InvalidPaymentMethod,
      });
    });

    it('Payment failed returned', async () => {
      const collected = harness.provider.collectPaymentMethod();
      // The provider declines the card, as it would for a real decline.
      harness.provider.failNext(
        'attachPaymentMethod',
        new BillingException(
          ErrorCode.PaymentFailed,
          'The card was declined.',
          402,
        ),
      );

      const response = await harness
        .post('/payment-methods', user)
        .send({ paymentMethodId: collected.id })
        .expect(402);

      expect(response.body).toMatchObject({ code: ErrorCode.PaymentFailed });
    });

    it('Missing Stripe customer returned', async () => {
      // A customer identifier the provider does not recognise: the local row
      // points at something that is gone.
      await testDatabase.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: 'cus_vanished' },
      });

      const response = await harness
        .post('/subscriptions', user)
        .send({ billingInterval: BillingInterval.MONTH, ...CHECKOUT_URLS })
        .expect(502);

      expect(response.body).toMatchObject({
        code: ErrorCode.MissingStripeCustomer,
      });
    });

    it('Invalid subscription state returned', async () => {
      const response = await harness
        .post('/addons', user)
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS })
        .expect(409);

      expect(response.body).toMatchObject({
        code: ErrorCode.InvalidSubscriptionState,
      });
    });

    it('Duplicate event returned', async () => {
      const delivery = harness.provider.deliver(
        'customer.discount.created',
        null,
      );
      await postWebhook(delivery).expect(200);

      const redelivered = await postWebhook(
        harness.provider.redeliver(delivery),
      ).expect(200);

      // Acknowledged, because a non-2xx would ask the provider to retry an
      // event whose effects have already happened — and named, so the caller
      // can tell why nothing changed.
      expect(redelivered.body).toMatchObject({
        outcome: 'duplicate',
        code: ErrorCode.DuplicateEvent,
      });
    });

    it('Invalid webhook signature returned', async () => {
      const delivery = harness.provider.deliver(
        'customer.discount.created',
        null,
      );

      const response = await postWebhook(delivery, 'not-the-signature').expect(
        400,
      );

      expect(response.body).toMatchObject({
        code: ErrorCode.InvalidWebhookSignature,
      });
    });

    it('Insufficient credits returned', async () => {
      const response = await harness
        .post('/credits/consume', user)
        .send({ amount: 1 })
        .expect(402);

      expect(response.body).toMatchObject({
        code: ErrorCode.InsufficientCredits,
      });
    });

    it('Invalid plan or cycle returned', async () => {
      // The annual SKU is not catalogued, so the cycle cannot be honoured.
      await testDatabase.prisma.pricingOption.deleteMany({
        where: { stripePriceId: PRICE_IDS.STRIPE_PRICE_AI_PRO_ANNUAL },
      });

      const response = await harness
        .post('/subscriptions', user)
        .send({ billingInterval: BillingInterval.YEAR, ...CHECKOUT_URLS })
        .expect(400);

      expect(response.body).toMatchObject({
        code: ErrorCode.InvalidPlanOrCycle,
      });
    });

    it('Stripe API error returned', async () => {
      harness.provider.failNext(
        'createCheckoutSession',
        new BillingException(
          ErrorCode.StripeApiError,
          'The billing provider is currently unavailable.',
          503,
        ),
      );

      const response = await harness
        .post('/subscriptions', user)
        .send({ billingInterval: BillingInterval.MONTH, ...CHECKOUT_URLS })
        .expect(503);

      expect(response.body).toMatchObject({ code: ErrorCode.StripeApiError });
    });

    it('Database transaction failed returned', async () => {
      const client = await testDatabase.newPgClient();
      // Fault injection at the level the code cannot anticipate: the database
      // refuses a write no application rule forbids.
      await client.query(
        `ALTER TABLE payment_methods
           ADD CONSTRAINT tmp_reject_writes CHECK (false) NOT VALID`,
      );

      try {
        const collected = harness.provider.collectPaymentMethod();

        const response = await harness
          .post('/payment-methods', user)
          .send({ paymentMethodId: collected.id })
          .expect(500);

        expect(response.body).toMatchObject({
          code: ErrorCode.DatabaseTransactionFailed,
        });
      } finally {
        await client.query(
          `ALTER TABLE payment_methods DROP CONSTRAINT tmp_reject_writes`,
        );
      }
    });
  });

  // ==========================================================================
  describe('Requirement: Error Response Shape', () => {
    it('Error shape structure', async () => {
      const response = await harness
        .post('/credits/consume', user)
        .send({ amount: 1 })
        .expect(402);

      expect(response.body).toMatchObject({
        statusCode: 402,
        code: anyString(),
        message: anyString(),
        path: '/credits/consume',
        timestamp: anyString(),
      });

      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toMatch(/at .*\.ts:\d+/);
      expect(serialised).not.toMatch(/\bstack\b/i);
      expect(serialised).not.toMatch(/node_modules/);
    });

    it('Validation errors', async () => {
      const response = await harness
        .post('/credits/consume', user)
        .send({ amount: -5 })
        .expect(400);

      expect(response.body).toMatchObject({
        code: ErrorCode.ValidationFailed,
        details: arrayContaining([stringContaining('amount')]),
      });
    });

    it('every code the contract requires is one this service can return', () => {
      // The enum is the contract; nothing here should have quietly vanished.
      expect(Object.values(ErrorCode)).toEqual(
        expect.arrayContaining([
          'INVALID_PAYMENT_METHOD',
          'PAYMENT_FAILED',
          'MISSING_STRIPE_CUSTOMER',
          'INVALID_SUBSCRIPTION_STATE',
          'DUPLICATE_EVENT',
          'INVALID_WEBHOOK_SIGNATURE',
          'INSUFFICIENT_CREDITS',
          'INVALID_PLAN_OR_CYCLE',
          'STRIPE_API_ERROR',
          'DATABASE_TRANSACTION_FAILED',
        ]),
      );
    });
  });

  // ==========================================================================
  describe('Requirement: Swagger Documentation', () => {
    it('Swagger UI accessible', () => {
      // The document is what the UI serves; building it here proves the
      // decorators produce a valid spec without starting a browser.
      const document = buildOpenApiDocument(harness.app);

      expect(document.openapi).toMatch(/^3\./);
      expect(document.info.title).toBe('Billing Service');
      expect(document.components?.securitySchemes).toHaveProperty('bearer');
    });

    it('All endpoints documented', () => {
      const document = buildOpenApiDocument(harness.app);

      const documented = new Set(
        Object.entries(document.paths).flatMap(([path, item]) =>
          Object.keys(item as Record<string, unknown>)
            .filter((method) =>
              ['get', 'post', 'patch', 'put', 'delete'].includes(method),
            )
            .map((method) => `${method.toUpperCase()} ${path}`),
        ),
      );

      for (const route of [
        'POST /auth/register',
        'POST /auth/login',
        'GET /customer',
        'GET /payment-methods',
        'POST /payment-methods',
        'DELETE /payment-methods/{id}',
        'PATCH /payment-methods/{id}/default',
        'GET /subscriptions',
        'GET /subscriptions/current',
        'POST /subscriptions',
        'PATCH /subscriptions/{id}/cycle',
        'POST /subscriptions/{id}/cancel',
        'POST /subscriptions/{id}/cancel-now',
        'POST /subscriptions/{id}/reactivate',
        'GET /addons',
        'POST /addons',
        'GET /credits/balance',
        'POST /credits/consume',
        'GET /credits/history',
        'GET /history/payments',
        'GET /history/subscriptions',
        'GET /history/credits',
        'POST /webhooks/stripe',
        'GET /health',
      ]) {
        expect(documented).toContain(route);
      }
    });

    it('marks the protected endpoints as needing a bearer token', () => {
      const document = buildOpenApiDocument(harness.app);

      const secured = (path: string, method: string) =>
        (
          (
            document.paths[path] as Record<
              string,
              { security?: unknown[] } | undefined
            >
          )[method]?.security ?? []
        ).length > 0;

      expect(secured('/credits/balance', 'get')).toBe(true);
      expect(secured('/subscriptions', 'post')).toBe(true);
      // The public routes carry no requirement.
      expect(secured('/auth/login', 'post')).toBe(false);
      expect(secured('/webhooks/stripe', 'post')).toBe(false);
    });

    it('documents a Pro subscriber flow end to end', async () => {
      const subscriptionId = await upgradeToPro();

      const current = await harness
        .get('/subscriptions/current', user)
        .expect(200);

      expect(current.body).toMatchObject({ id: subscriptionId });
    });
  });
});
