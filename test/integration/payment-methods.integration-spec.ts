import request from 'supertest';
import { ApiHarness } from './api-harness';
import type { RegisteredUser } from './api-harness';
import { testDatabase } from './test-database';

/**
 * Payment methods and their mirror, asserted against
 * `specs/payment-method-mirror/spec.md` and the payment-method requirements of
 * `specs/api-endpoints/spec.md`. Scenario names are verbatim.
 */

const harness = new ApiHarness();

describe('payment methods', () => {
  let user: RegisteredUser;
  let customerId: string;

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
    customerId = await stripeCustomerIdOf(user.id);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function stripeCustomerIdOf(userId: string): Promise<string> {
    const row = await testDatabase.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    // Free provisioning creates it during registration.
    return row.stripeCustomerId!;
  }

  /** A method the client has collected at the provider but not yet attached. */
  function collect(
    overrides: Parameters<typeof harness.provider.collectPaymentMethod>[0] = {},
  ) {
    return harness.provider.collectPaymentMethod(overrides);
  }

  interface AttachedBody {
    id: string;
    providerPaymentMethodId: string;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    isDefault: boolean;
  }

  async function attach(paymentMethodId: string): Promise<AttachedBody> {
    const response = await harness
      .post('/payment-methods', user)
      .send({ paymentMethodId })
      .expect(201);
    return response.body as AttachedBody;
  }

  function mirrorRows() {
    return testDatabase.prisma.paymentMethod.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ==========================================================================
  describe('Requirement: Payment Method Mirror Written From Provider State', () => {
    it('Mirror written on attach', async () => {
      const collected = collect({ brand: 'visa', last4: '4242' });

      // Nothing exists before the request.
      expect(await mirrorRows()).toHaveLength(0);

      const attached = await attach(collected.id);

      expect(attached).toMatchObject({
        providerPaymentMethodId: collected.id,
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: 2030,
      });
      const rows = await mirrorRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].providerPaymentMethodId).toBe(collected.id);
    });

    it('writes no record when the provider refuses', async () => {
      const collected = collect();
      harness.provider.failNext(
        'attachPaymentMethod',
        new Error('provider refused'),
      );

      await harness
        .post('/payment-methods', user)
        .send({ paymentMethodId: collected.id })
        .expect(500);

      // The row would have been the mirror leading the provider.
      expect(await mirrorRows()).toHaveLength(0);
    });

    it('No card data stored', async () => {
      const collected = collect();
      await attach(collected.id);

      const columns = await testDatabase.prisma.$queryRaw<
        { column_name: string }[]
      >`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'payment_methods'
      `;
      const names = columns.map((column) => column.column_name);

      expect(names).toEqual(
        expect.arrayContaining(['brand', 'last4', 'exp_month', 'exp_year']),
      );
      for (const name of names) {
        expect(name).not.toMatch(/card_number|number$|cvc|cvv|security/i);
      }
    });
  });

  // ==========================================================================
  describe('Requirement: Payment Method Endpoints', () => {
    it('List payment methods', async () => {
      const first = await attach(collect({ last4: '4242' }).id);
      const second = await attach(collect({ last4: '1881' }).id);

      const response = await harness.get('/payment-methods', user).expect(200);

      const listed = response.body as { id: string }[];
      expect(listed.map((method) => method.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    it('Detach payment method', async () => {
      const attached = await attach(collect().id);

      await harness.delete(`/payment-methods/${attached.id}`, user).expect(204);

      expect(await mirrorRows()).toHaveLength(0);
      expect(harness.provider.callsTo('detachPaymentMethod')).toHaveLength(1);
    });

    it('Set default payment method', async () => {
      const first = await attach(collect({ last4: '4242' }).id);
      const second = await attach(collect({ last4: '1881' }).id);
      // The first method a customer holds is the provider's default.
      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);

      const response = await harness
        .patch(`/payment-methods/${second.id}/default`, user)
        .expect(200);

      expect(response.body).toMatchObject({ id: second.id, isDefault: true });
      const rows = await mirrorRows();
      expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
      expect(rows.find((row) => row.id === first.id)!.isDefault).toBe(false);
      // The provider is what actually decides; the mirror followed.
      expect(harness.provider.defaultPaymentMethods.get(customerId)).toBe(
        second.providerPaymentMethodId,
      );
    });

    it('refuses a payment method belonging to another user', async () => {
      const stranger = await harness.register();
      const strangerCustomer = await stripeCustomerIdOf(stranger.id);
      const collected = collect();
      await harness.provider.attachPaymentMethod(
        strangerCustomer,
        collected.id,
      );
      await harness
        .post('/payment-methods', stranger)
        .send({ paymentMethodId: collected.id })
        .expect(201);

      const response = await harness
        .delete(`/payment-methods/${collected.id}`, user)
        .expect(400);

      expect(response.body).toMatchObject({ code: 'INVALID_PAYMENT_METHOD' });
      expect(harness.provider.paymentMethods.has(collected.id)).toBe(true);
    });
  });

  // ==========================================================================
  describe('Requirement: Mirror Refreshed By Webhook Events', () => {
    it('Attached event creates mirror', async () => {
      // Attached outside the API, as the provider dashboard would.
      const collected = collect({ last4: '0005' });
      await harness.provider.attachPaymentMethod(customerId, collected.id);
      expect(await mirrorRows()).toHaveLength(0);

      const receipt = await deliver('payment_method.attached', {
        ...collected,
        customerId,
      });

      expect(receipt.outcome).toBe('processed');
      const rows = await mirrorRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        providerPaymentMethodId: collected.id,
        last4: '0005',
        isDefault: true,
      });
    });

    it('Detached event removes mirror', async () => {
      const collected = collect();
      const attached = await attach(collected.id);
      await harness.provider.detachPaymentMethod(collected.id);

      const receipt = await deliver('payment_method.detached', {
        ...collected,
        customerId: null,
      });

      expect(receipt.outcome).toBe('processed');
      expect(await mirrorRows()).toHaveLength(0);
      expect(attached.id).toEqual(expect.any(String));
    });

    it('Updated event refreshes mirror', async () => {
      const collected = collect({ last4: '4242', expYear: 2030 });
      await attach(collected.id);

      // The card was updated at the provider — a new expiry after a reissue.
      const updated = {
        ...collected,
        customerId,
        last4: '4242',
        expYear: 2032,
      };
      harness.provider.paymentMethods.set(collected.id, updated);

      const receipt = await deliver('payment_method.updated', updated);

      expect(receipt.outcome).toBe('processed');
      const rows = await mirrorRows();
      expect(rows[0]).toMatchObject({ expYear: 2032 });
    });

    it('ignores an event for a customer this service does not know', async () => {
      const collected = collect();

      const receipt = await deliver('payment_method.attached', {
        ...collected,
        customerId: 'cus_someone_else',
      });

      expect(receipt.outcome).toBe('ignored');
      expect(await mirrorRows()).toHaveLength(0);
    });
  });

  // ==========================================================================
  describe('Requirement: One Default Per User', () => {
    it('Setting a default clears others', async () => {
      const first = await attach(collect().id);
      const second = await attach(collect().id);

      await harness
        .patch(`/payment-methods/${second.id}/default`, user)
        .expect(200);

      const rows = await mirrorRows();
      expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([
        second.id,
      ]);
      expect(first.isDefault).toBe(true);
    });

    it('Constraint prevents two defaults', async () => {
      const first = await attach(collect().id);
      const second = await attach(collect().id);
      expect(first.isDefault).toBe(true);
      expect(second.isDefault).toBe(false);

      const client = await testDatabase.newPgClient();

      // Written directly, bypassing the service entirely: the invariant has to
      // hold against the database, not against the code that usually writes it.
      await expect(
        client.query(
          `UPDATE payment_methods SET is_default = true WHERE id = $1`,
          [second.id],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  // ==========================================================================
  describe('Requirement: Mirror Is Not Authority For Charging', () => {
    it('Charging uses provider default', async () => {
      const first = await attach(collect().id);
      const second = await attach(collect().id);

      // The mirror is edited behind the service's back to name a different
      // card. Nothing about what the provider charges changes.
      await testDatabase.prisma.$transaction([
        testDatabase.prisma.paymentMethod.updateMany({
          where: { id: first.id },
          data: { isDefault: false },
        }),
        testDatabase.prisma.paymentMethod.updateMany({
          where: { id: second.id },
          data: { isDefault: true },
        }),
      ]);

      expect(harness.provider.defaultPaymentMethods.get(customerId)).toBe(
        (await mirrorRows()).find((row) => row.id === first.id)!
          .providerPaymentMethodId,
      );
    });
  });

  // -------------------------------------------------------------------------

  /**
   * Delivers a payment-method event over HTTP, the way the provider would. The
   * endpoint is public, so no token is sent.
   */
  async function deliver(
    type:
      | 'payment_method.attached'
      | 'payment_method.detached'
      | 'payment_method.updated',
    paymentMethod: Parameters<
      typeof harness.provider.deliverPaymentMethodEvent
    >[1],
  ): Promise<{ outcome: string }> {
    const delivery = harness.provider.deliverPaymentMethodEvent(
      type,
      paymentMethod,
    );

    const response = await request(harness.server)
      .post('/webhooks/stripe')
      .set('stripe-signature', delivery.signature)
      .set('content-type', 'application/json')
      .send(delivery.payload.toString('utf8'))
      .expect(200);

    return response.body as { outcome: string };
  }
});
