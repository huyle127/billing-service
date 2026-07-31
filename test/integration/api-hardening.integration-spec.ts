import request from 'supertest';
import { RATE_LIMITS } from '../../src/common/throttling/rate-limit-tiers';
import { ApiHarness, CHECKOUT_URLS } from './api-harness';
import type { RegisteredUser } from './api-harness';
import { testDatabase } from './test-database';

/**
 * The HTTP-level protections, asserted against `specs/api-hardening/spec.md`.
 * Scenario names are verbatim.
 *
 * **A harness per test, not per file.** The tiers are counted in memory for the
 * lifetime of an application instance, over a window of a minute — longer than
 * any suite runs. Sharing one instance would mean the first test to exhaust the
 * five-per-minute auth budget breaks every test after it, and the order they
 * ran in would decide which ones passed. A fresh instance per test is what
 * makes each budget an assertion about the tier rather than about the ones
 * before it.
 *
 * These are the only tests that run with limits enforced; every other suite
 * disables them, because registering a user per case exhausts the auth tier
 * within a few tests. The limits asserted below are the real ones, read from
 * the same table the application is configured from — the numbers are not
 * duplicated here, so a change to a tier shows up as a failing assertion about
 * *behaviour* rather than as two constants quietly disagreeing.
 */

const ALLOWED_ORIGIN = 'https://app.test.local';
const REFUSED_ORIGIN = 'https://not-ours.test.local';

const TOO_MANY_REQUESTS = 429;

describe('API hardening', () => {
  let harness: ApiHarness;

  beforeEach(async () => {
    harness = new ApiHarness({
      rateLimiting: true,
      corsOrigins: [ALLOWED_ORIGIN],
    });
    await harness.start();
    await harness.seedCatalog();
  });

  afterEach(async () => {
    await harness.stop();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** Registering costs one request from the auth tier; callers must count it. */
  function register(): Promise<RegisteredUser> {
    return harness.register();
  }

  function login(email: string, password: string) {
    return request(harness.server)
      .post('/auth/login')
      .send({ email, password });
  }

  function startCheckout(user: RegisteredUser) {
    return harness
      .post('/subscriptions', user)
      .send({ billingInterval: 'MONTH', ...CHECKOUT_URLS });
  }

  function consume(user: RegisteredUser) {
    return harness.post('/credits/consume', user).send({ amount: 1 });
  }

  function unhandledDelivery() {
    // Translates to no billing event, so the endpoint does the intake work —
    // signature verification and the durable record — and no handler work. The
    // burst under test is about intake being refused, not about fulfilment.
    return harness.provider.deliver('customer.discount.created', null);
  }

  /** A refusal minus the fields that differ between any two responses. */
  function refusalShape(response: request.Response) {
    const { timestamp, ...rest } = response.body as Record<string, unknown>;
    void timestamp;
    return rest;
  }

  function postWebhook(delivery: { payload: Buffer; signature: string }) {
    return request(harness.server)
      .post('/webhooks/stripe')
      .set('stripe-signature', delivery.signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'));
  }

  // ==========================================================================
  describe('Requirement: Endpoints Have A Request Rate Ceiling', () => {
    it('Repeated login attempts are refused', async () => {
      const user = await register(); // Request 1 of the auth tier.
      const budget = RATE_LIMITS.auth.limit;

      // Spend the rest of the tier on logins that would otherwise be answered.
      for (let attempt = 2; attempt <= budget; attempt += 1) {
        const response = await login(user.email, user.password);
        expect(response.status).not.toBe(TOO_MANY_REQUESTS);
      }

      // Correct credentials, and refused anyway: the ceiling is reached before
      // the password is looked at, which is the point. A limit applied after a
      // credential check would have done the expensive work first.
      const refused = await login(user.email, user.password);
      expect(refused.status).toBe(TOO_MANY_REQUESTS);
      expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });

      // The refusal says nothing about the account: an unknown email, a wrong
      // password, and the correct credentials are answered identically once the
      // limit is reached — so the throttled path cannot be used as an oracle
      // for which addresses are registered.
      const unknown = await login('nobody@test.local', 'whatever');
      const wrongPassword = await login(user.email, 'not-the-password');
      expect(unknown.status).toBe(TOO_MANY_REQUESTS);
      // Everything but the timestamp, which differs between any two responses
      // and carries nothing about the account.
      expect(refusalShape(unknown)).toEqual(refusalShape(refused));
      expect(refusalShape(wrongPassword)).toEqual(refusalShape(refused));
      expect(JSON.stringify(unknown.body)).not.toContain(user.email);
    });

    it('Checkout creation is bounded per user', async () => {
      const user = await register();
      const budget = RATE_LIMITS.checkout.limit;

      for (let attempt = 1; attempt <= budget; attempt += 1) {
        await startCheckout(user).expect(201);
      }

      const refused = await startCheckout(user);
      expect(refused.status).toBe(TOO_MANY_REQUESTS);
      expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });

      // No provider object was created by the refused request. The guard runs
      // before the controller, so the Stripe call is never reached — which is
      // the whole reason to bound this endpoint rather than a cheaper one.
      expect(harness.provider.callsTo('createCheckoutSession')).toHaveLength(
        budget,
      );
    });

    it('the checkout tier is one budget across both routes it covers', async () => {
      // `POST /subscriptions` and `POST /addons` share ten a minute rather than
      // getting ten each: the design states the limit per route *group*, and
      // the alternative would let a caller create twice as many provider
      // objects as the tier claims to allow.
      const user = await register();

      for (
        let attempt = 1;
        attempt < RATE_LIMITS.checkout.limit;
        attempt += 1
      ) {
        await startCheckout(user).expect(201);
      }

      // The tenth request against the tier, spent on the other route in it.
      const addon = await harness
        .post('/addons', user)
        .send({ addonPackageKey: 'credits-100', ...CHECKOUT_URLS });
      expect(addon.status).not.toBe(TOO_MANY_REQUESTS);

      const refused = await startCheckout(user);
      expect(refused.status).toBe(TOO_MANY_REQUESTS);
    });

    it('Credit consumption is bounded per user', async () => {
      const user = await register();
      const budget = RATE_LIMITS.consume.limit;

      // Free grants fewer credits than this tier allows requests, so the later
      // attempts are refused for want of balance rather than answered. Both
      // outcomes are the endpoint doing its job, and both count against the
      // tier — what matters here is that neither is a rate-limit refusal.
      for (let attempt = 1; attempt <= budget; attempt += 1) {
        const response = await consume(user);
        expect(response.status).not.toBe(TOO_MANY_REQUESTS);
      }

      const refused = await consume(user);
      expect(refused.status).toBe(TOO_MANY_REQUESTS);
      expect(refused.body).toMatchObject({ code: 'RATE_LIMITED' });

      // Nothing was spent by the refused request. The ledger is the evidence:
      // it holds one movement per request that actually reached the service,
      // and the refused one added none.
      const movements = () =>
        testDatabase.prisma.creditTransaction.count({
          where: { creditGrant: { userId: user.id } },
        });

      const spentBefore = await movements();
      await consume(user).expect(TOO_MANY_REQUESTS);
      expect(await movements()).toBe(spentBefore);
    });

    it('applies a default ceiling to routes in no other tier', async () => {
      const user = await register();
      const budget = RATE_LIMITS.default.limit;

      for (let attempt = 1; attempt <= budget; attempt += 1) {
        await harness.get('/credits/balance', user).expect(200);
      }

      const refused = await harness.get('/credits/balance', user);
      expect(refused.status).toBe(TOO_MANY_REQUESTS);
    });

    describe('Scenario: Limits are keyed appropriately', () => {
      it('a per-user limit is evaluated after the caller is authenticated', async () => {
        // Two users behind one address. If the tier were counted per address —
        // which is what it would fall back to if it ran before the JWT guard
        // and found no principal — the second user would inherit the first
        // user's exhausted budget. Each having their own is only possible if
        // the limit saw an authenticated principal.
        const first = await register();
        const second = await register();

        for (
          let attempt = 1;
          attempt <= RATE_LIMITS.checkout.limit;
          attempt += 1
        ) {
          await startCheckout(first).expect(201);
        }
        await startCheckout(first).expect(TOO_MANY_REQUESTS);

        await startCheckout(second).expect(201);
      });

      it("an authentication endpoint's limit is evaluated before any credential work", async () => {
        // An address-keyed tier, so exhausting it with registrations refuses a
        // login for an account that exists and whose password is correct. The
        // service cannot have checked: it answers the same for an account that
        // does not exist.
        for (let attempt = 1; attempt <= RATE_LIMITS.auth.limit; attempt += 1) {
          await request(harness.server)
            .post('/auth/register')
            .send({
              email: `burst-${attempt}@test.local`,
              password: 'test-password',
            });
        }

        const refused = await login('burst-1@test.local', 'test-password');
        expect(refused.status).toBe(TOO_MANY_REQUESTS);

        // The account really was usable — the refusal was the limit, not the
        // credentials. A fresh instance is the only way to ask, since the
        // budget has a minute left to run.
        const other = new ApiHarness();
        await other.start();
        try {
          const accepted = await request(other.server)
            .post('/auth/login')
            .send({ email: 'burst-1@test.local', password: 'test-password' });
          expect(accepted.status).toBe(200);
        } finally {
          await other.stop();
        }
      });
    });
  });

  // ==========================================================================
  describe('Requirement: The Webhook Endpoint Is Exempt From Rate Limiting', () => {
    it('A burst of deliveries is accepted', async () => {
      // Comfortably past the default ceiling, which is the limit the endpoint
      // would fall under if it were in no tier of its own. Stripe delivers a
      // backlog like this after an outage; a 429 would ask it to retry into
      // the same limit and convert the spike into a stall.
      const burst = RATE_LIMITS.default.limit + 20;

      const statuses: number[] = [];
      for (let delivery = 1; delivery <= burst; delivery += 1) {
        const response = await postWebhook(unhandledDelivery());
        statuses.push(response.status);
      }

      expect(statuses).toHaveLength(burst);
      expect(statuses.filter((status) => status !== 200)).toEqual([]);
    });

    it("The endpoint's protection is its signature check", async () => {
      const delivery = unhandledDelivery();

      const tampered = await request(harness.server)
        .post('/webhooks/stripe')
        .set('stripe-signature', 'not-a-valid-signature')
        .set('content-type', 'application/json')
        .send(delivery.payload.toString('utf8'));

      // Refused on the signature, at the first request rather than the
      // hundred-and-first — so removing the rate limit did not make the
      // endpoint callable by an unsigned caller.
      expect(tampered.status).toBe(400);
      expect(tampered.body).toMatchObject({
        code: 'INVALID_WEBHOOK_SIGNATURE',
      });
    });

    it('leaves the health check usable by an orchestrator probe', async () => {
      // Probed on a fixed schedule from a small number of addresses. A 429
      // reads as an unhealthy service and gets the container replaced.
      const probes = RATE_LIMITS.default.limit + 20;

      for (let probe = 1; probe <= probes; probe += 1) {
        await request(harness.server).get('/health').expect(200);
      }
    });
  });

  // ==========================================================================
  describe('Requirement: Security Response Headers Are Applied', () => {
    it('Headers are present on every response', async () => {
      const user = await register();

      const responses = [
        await request(harness.server).get('/health'),
        await harness.get('/credits/balance', user),
        // An error response, and an unauthenticated one: the headers come from
        // middleware ahead of the guards, so a refusal carries them too.
        await request(harness.server).get('/credits/balance'),
        await request(harness.server).get('/nothing-here'),
      ];

      for (const response of responses) {
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-security-policy']).toBeDefined();
        expect(response.headers['strict-transport-security']).toBeDefined();
        expect(response.headers['referrer-policy']).toBeDefined();
        expect(response.headers['x-frame-options']).toBeDefined();
        // Removed rather than merely overwritten: the server's identity is not
        // something a client needs.
        expect(response.headers['x-powered-by']).toBeUndefined();
      }
    });

    it('no route opts out individually', async () => {
      // Including the one route with its own body handling, which is where an
      // exemption would be easiest to introduce by accident.
      const webhook = await postWebhook(unhandledDelivery());

      expect(webhook.status).toBe(200);
      expect(webhook.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  // ==========================================================================
  describe('Requirement: Cross-Origin Access Is Explicit', () => {
    it('A permitted origin is accepted', async () => {
      const response = await request(harness.server)
        .get('/health')
        .set('Origin', ALLOWED_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(
        ALLOWED_ORIGIN,
      );
    });

    it('An unnamed origin is refused', async () => {
      const response = await request(harness.server)
        .get('/health')
        .set('Origin', REFUSED_ORIGIN);

      // The header is absent, so the browser refuses the response to the page
      // that asked for it. Nothing is echoed back, and no wildcard is sent.
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('permits nothing when no allowlist is configured', async () => {
      // The default must be an empty allowlist rather than a wildcard: an
      // unset variable should not be the thing that opens the API to every
      // origin on the web.
      const unconfigured = new ApiHarness({ corsOrigins: [] });
      await unconfigured.start();

      try {
        const response = await request(unconfigured.server)
          .get('/health')
          .set('Origin', ALLOWED_ORIGIN);

        expect(response.status).toBe(200);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      } finally {
        await unconfigured.stop();
      }
    });
  });
});
