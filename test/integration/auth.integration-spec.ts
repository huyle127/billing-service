import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApiHarness } from './api-harness';
import type { RegisteredUser } from './api-harness';
import { testDatabase } from './test-database';

/**
 * Authentication, asserted against `specs/user-auth/spec.md`. Scenario names are
 * verbatim.
 */
const harness = new ApiHarness();

describe('authentication', () => {
  let productId: string;

  beforeAll(async () => {
    await harness.start();
  });

  afterAll(async () => {
    await harness.stop();
  });

  beforeEach(async () => {
    harness.provider.reset();
    productId = await harness.seedCatalog();
  });

  // ==========================================================================
  describe('Requirement: User Registration', () => {
    it('Successful registration', async () => {
      const email = `${randomUUID()}@test.local`;

      const response = await request(harness.server)
        .post('/auth/register')
        .send({ email, password: 'test-password' })
        .expect(201);

      const body = response.body as {
        user: { id: string; email: string };
        accessToken: string;
      };
      expect(body.user.email).toBe(email);
      expect(body.accessToken).toEqual(expect.any(String));

      const user = await testDatabase.prisma.user.findUniqueOrThrow({
        where: { email },
      });
      // Stored hashed, never in the clear, and never returned.
      expect(user.passwordHash).not.toBe('test-password');
      expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(JSON.stringify(body)).not.toContain('passwordHash');

      // Free provisioning ran for the AI product.
      const subscriptions = await testDatabase.prisma.subscription.findMany({
        where: { userId: user.id, productId },
        include: { plan: true },
      });
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].plan.isPaid).toBe(false);
      expect(subscriptions[0].providerSubscriptionId).toMatch(/^sub_/);
    });

    it('Duplicate email', async () => {
      const user = await harness.register();
      const before = await testDatabase.prisma.user.count();

      const response = await request(harness.server)
        .post('/auth/register')
        .send({ email: user.email, password: 'another-password' })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'CONFLICT' });
      expect(await testDatabase.prisma.user.count()).toBe(before);
    });

    it('Invalid email format', async () => {
      const response = await request(harness.server)
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'test-password' })
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await testDatabase.prisma.user.count()).toBe(0);
    });

    it('Weak password', async () => {
      const response = await request(harness.server)
        .post('/auth/register')
        .send({ email: `${randomUUID()}@test.local`, password: 'short' })
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await testDatabase.prisma.user.count()).toBe(0);
    });
  });

  // ==========================================================================
  describe('Requirement: User Login', () => {
    it('Successful login', async () => {
      const user = await harness.register();

      const response = await request(harness.server)
        .post('/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);

      const body = response.body as {
        user: { id: string };
        accessToken: string;
      };
      expect(body.user.id).toBe(user.id);

      // The token carries the user id, which is what scopes every operation.
      const claims = decodeClaims(body.accessToken);
      expect(claims.sub).toBe(user.id);
      expect(claims.exp).toEqual(expect.any(Number));
    });

    it('Invalid credentials', async () => {
      const user = await harness.register();

      const response = await request(harness.server)
        .post('/auth/login')
        .send({ email: user.email, password: 'wrong-password' })
        .expect(401);

      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('User not found', async () => {
      const response = await request(harness.server)
        .post('/auth/login')
        .send({ email: `${randomUUID()}@test.local`, password: 'whatever' })
        .expect(401);

      // Identical to a wrong password, so the endpoint enumerates nobody.
      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });

  // ==========================================================================
  describe('Requirement: JWT Authentication', () => {
    it('Valid JWT', async () => {
      const user = await harness.register();

      const response = await harness.get('/customer', user).expect(200);

      expect(response.body).toMatchObject({ email: user.email });
    });

    it('Missing JWT', async () => {
      const response = await request(harness.server)
        .get('/customer')
        .expect(401);

      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('Invalid JWT', async () => {
      const response = await request(harness.server)
        .get('/customer')
        .set('Authorization', 'Bearer not-a-token')
        .expect(401);

      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('Expired JWT', async () => {
      const user = await harness.register();
      const expired = signExpiredToken(user);

      const response = await request(harness.server)
        .get('/customer')
        .set('Authorization', `Bearer ${expired}`)
        .expect(401);

      expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('scopes the operation to the token holder', async () => {
      const first = await harness.register();
      const second = await harness.register();

      const response = await harness.get('/customer', second).expect(200);

      expect(response.body).toMatchObject({ email: second.email });
      expect(response.body).not.toMatchObject({ email: first.email });
    });
  });

  // ==========================================================================
  describe('Requirement: Public Endpoints', () => {
    it('Registration without JWT', async () => {
      await request(harness.server)
        .post('/auth/register')
        .send({
          email: `${randomUUID()}@test.local`,
          password: 'test-password',
        })
        .expect(201);
    });

    it('Login without JWT', async () => {
      const user = await harness.register();

      await request(harness.server)
        .post('/auth/login')
        .send({ email: user.email, password: user.password })
        .expect(200);
    });

    it('Webhook without JWT', async () => {
      const delivery = harness.provider.deliver(
        'customer.discount.created',
        null,
      );

      const response = await request(harness.server)
        .post('/webhooks/stripe')
        .set('stripe-signature', delivery.signature)
        .set('content-type', 'application/json')
        .send(delivery.payload.toString('utf8'));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: 'unhandled' });
    });
  });
});

// ---------------------------------------------------------------------------

function decodeClaims(token: string): { sub: string; exp: number } {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    sub: string;
    exp: number;
  };
}

/**
 * A token this service would have issued, had it been issued long enough ago to
 * have expired. Signed by the service's own signer, so what the guard rejects is
 * the expiry rather than the signature.
 */
function signExpiredToken(user: RegisteredUser): string {
  return harness.app
    .get(JwtService)
    .sign({ sub: user.id, email: user.email }, { expiresIn: '-1s' });
}
