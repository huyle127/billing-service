import { beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../../../common/clock/fixed-clock';
import { FakeStripeAdapter } from './fake-stripe.adapter';
import { StripeAdapterError } from '../stripe.error';

const NOW = new Date('2026-03-01T00:00:00.000Z');

describe('FakeStripeAdapter', () => {
  let clock: FixedClock;
  let stripe: FakeStripeAdapter;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    stripe = new FakeStripeAdapter(clock);
  });

  async function seedSubscription(userId = 'user_1', subscriptionId = 'sub_local_1') {
    const customer = await stripe.createCustomer({ userId, email: `${userId}@example.com` });
    const product = await stripe.createProduct({ code: 'pro', name: 'Pro' });
    const price = await stripe.createPrice({
      code: 'pro',
      productId: product.id,
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
    });
    const subscription = await stripe.createSubscription({
      subscriptionId,
      userId,
      customerId: customer.id,
      priceId: price.id,
    });

    return { customer, product, price, subscription };
  }

  it('carries a subscription through create, retrieve, update, and cancel', async () => {
    const { customer, subscription, price } = await seedSubscription();

    expect(subscription.customerId).toBe(customer.id);
    expect(subscription.status).toBe('active');
    expect(subscription.priceId).toBe(price.id);
    expect(subscription.currentPeriodEnd).toEqual(new Date('2026-04-01T00:00:00.000Z'));
    expect(subscription.billingMode).toBe('flexible');

    const retrieved = await stripe.retrieveSubscription(subscription.id);
    expect(retrieved).toEqual(subscription);

    const annual = await stripe.createPrice({
      code: 'pro-annual',
      productId: price.productId,
      unitAmount: 20000,
      currency: 'usd',
      interval: 'year',
    });
    const updated = await stripe.updateSubscription(subscription.id, { priceId: annual.id });
    expect(updated.priceId).toBe(annual.id);
    expect((await stripe.retrieveSubscription(subscription.id))?.priceId).toBe(annual.id);
  });

  it('reports a cancelled subscription rather than dropping it', async () => {
    const { subscription } = await seedSubscription();

    const atPeriodEnd = await stripe.cancelSubscription(subscription.id, { atPeriodEnd: true });
    expect(atPeriodEnd.cancelAtPeriodEnd).toBe(true);
    expect(atPeriodEnd.status).toBe('active');

    const immediately = await stripe.cancelSubscription(subscription.id, { atPeriodEnd: false });
    expect(immediately.status).toBe('canceled');
    expect(await stripe.retrieveSubscription(subscription.id)).not.toBeNull();
  });

  it('returns the first object when a create is retried under the same derived key', async () => {
    const first = await stripe.createCustomer({ userId: 'user_1', email: 'a@example.com' });
    const second = await stripe.createCustomer({ userId: 'user_1', email: 'a@example.com' });

    expect(second.id).toBe(first.id);
    expect(stripe.customerCount).toBe(1);
  });

  it('does not confuse the keys of two different users', async () => {
    const first = await stripe.createCustomer({ userId: 'user_1', email: 'a@example.com' });
    const second = await stripe.createCustomer({ userId: 'user_2', email: 'b@example.com' });

    expect(second.id).not.toBe(first.id);
    expect(stripe.customerCount).toBe(2);
  });

  it('finds a created object by the identifiers it was tagged with', async () => {
    const { customer, subscription } = await seedSubscription('user_7', 'sub_local_7');

    expect(await stripe.findCustomerByUserId('user_7')).toEqual(customer);
    expect(await stripe.findSubscriptionByLocalId('sub_local_7')).toEqual(subscription);
    expect(customer.metadata).toEqual({ userId: 'user_7' });
    expect(subscription.metadata).toEqual({ userId: 'user_7', subscriptionId: 'sub_local_7' });
  });

  it('returns nothing for an identifier no object carries', async () => {
    await seedSubscription('user_7', 'sub_local_7');

    expect(await stripe.findCustomerByUserId('user_absent')).toBeNull();
    expect(await stripe.findSubscriptionByLocalId('sub_local_absent')).toBeNull();
    expect(await stripe.retrieveCustomer('cus_absent')).toBeNull();
  });

  it('adopts an object found by metadata once the idempotency key has expired', async () => {
    const created = await stripe.createCustomer({ userId: 'user_1', email: 'a@example.com' });

    stripe.expireIdempotencyKeys();

    expect(await stripe.findCustomerByUserId('user_1')).toEqual(created);
    expect(stripe.customerCount).toBe(1);
  });

  it('fails the way the real adapter fails', async () => {
    stripe.failNext('createCustomer', 'rate_limit');
    await expect(stripe.createCustomer({ userId: 'u', email: 'a@example.com' })).rejects.toThrow(
      StripeAdapterError,
    );

    const verdictOf = async (kind: 'rate_limit' | 'invalid_request') => {
      stripe.failNext('createCustomer', kind);
      const thrown = await stripe
        .createCustomer({ userId: 'u', email: 'a@example.com' })
        .then(() => null)
        .catch((error: unknown) => error as StripeAdapterError);

      return thrown?.verdict;
    };

    expect(await verdictOf('rate_limit')).toBe('retryable');
    expect(await verdictOf('invalid_request')).toBe('permanent');
  });

  it('records credits and payments as integers on a one-time payment', async () => {
    const customer = await stripe.createCustomer({ userId: 'user_1', email: 'a@example.com' });
    const method = await stripe.attachPaymentMethod({
      customerId: customer.id,
      paymentMethodId: 'pm_card_visa',
      setAsDefault: true,
    });

    const payment = await stripe.createOneTimePayment({
      purchaseId: 'purchase_1',
      userId: 'user_1',
      customerId: customer.id,
      paymentMethodId: method.id,
      amount: 1500,
      currency: 'usd',
    });

    expect(payment.amount).toBe(1500);
    expect(payment.status).toBe('succeeded');
    expect(payment.metadata).toEqual({ userId: 'user_1', purchaseId: 'purchase_1' });
    expect((await stripe.retrieveCustomer(customer.id))?.defaultPaymentMethodId).toBe(method.id);
  });

  it('detaches a payment method it previously attached', async () => {
    const customer = await stripe.createCustomer({ userId: 'user_1', email: 'a@example.com' });
    await stripe.attachPaymentMethod({
      customerId: customer.id,
      paymentMethodId: 'pm_card_visa',
      setAsDefault: false,
    });

    const detached = await stripe.detachPaymentMethod('pm_card_visa');

    expect(detached.customerId).toBeNull();
  });

  it('archives a price without deleting it', async () => {
    const product = await stripe.createProduct({ code: 'pro', name: 'Pro' });
    const price = await stripe.createPrice({
      code: 'pro',
      productId: product.id,
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
    });

    const archived = await stripe.archivePrice(price.id);

    expect(archived.active).toBe(false);
    expect(archived.id).toBe(price.id);
  });

  it('exposes an invoice whose payment is detected by status', async () => {
    const { subscription } = await seedSubscription();
    const invoiceId = subscription.latestInvoiceId as string;

    const invoice = await stripe.retrieveInvoice(invoiceId);

    expect(invoice?.status).toBe('paid');
    expect(invoice?.subscriptionId).toBe(subscription.id);
    expect(invoice?.amountPaid).toBe(2000);
  });
});
