import { checkoutCompletionOf } from './stripe-billing.provider';

/**
 * The two filters that decide whether a completed checkout is an add-on
 * fulfilment. This is the only place they can be asserted: the fake provider
 * integration tests use is handed an already-translated `BillingEvent`, so
 * nothing routed through it ever reaches this translation.
 *
 * The session is built from a plain literal rather than a Stripe type — this
 * file is scanned by `provider-boundary.spec.ts`, which requires that the
 * adapter is the only module importing the SDK, spec files included.
 */

type CheckoutSession = Parameters<typeof checkoutCompletionOf>[0];

function sessionOf(overrides: Record<string, unknown>): CheckoutSession {
  return {
    id: 'cs_test_1',
    mode: 'payment',
    payment_status: 'paid',
    payment_intent: 'pi_test_1',
    amount_total: 4900,
    currency: 'usd',
    ...overrides,
  } as unknown as CheckoutSession;
}

describe('checkoutCompletionOf', () => {
  it('translates a paid payment-mode session', () => {
    expect(checkoutCompletionOf(sessionOf({}))).toEqual({
      sessionId: 'cs_test_1',
      paymentIntentId: 'pi_test_1',
      amountTotal: 4900,
      currency: 'usd',
    });
  });

  it('ignores a subscription-mode session', () => {
    // `invoice.paid` owns that payment and allocates its credit period.
    // Translating it here too would mean two handlers for one payment, and
    // `fulfilPurchase` would throw — no AddonPurchase row exists for it.
    expect(
      checkoutCompletionOf(sessionOf({ mode: 'subscription' })),
    ).toBeNull();
  });

  it('ignores a session that completed without being paid', () => {
    // An asynchronous payment method settles after the session completes.
    // Granting credit here would grant it for money not collected.
    expect(
      checkoutCompletionOf(sessionOf({ payment_status: 'unpaid' })),
    ).toBeNull();
    expect(
      checkoutCompletionOf(
        sessionOf({ payment_status: 'no_payment_required' }),
      ),
    ).toBeNull();
  });

  it('ignores a subscription-mode session even when it is paid', () => {
    // Both filters are required; neither implies the other.
    expect(
      checkoutCompletionOf(
        sessionOf({ mode: 'subscription', payment_status: 'paid' }),
      ),
    ).toBeNull();
  });

  it('reads the identifier from an expanded payment intent', () => {
    // Stripe expands references inconsistently; only the id is wanted.
    expect(
      checkoutCompletionOf(sessionOf({ payment_intent: { id: 'pi_test_2' } })),
    ).toMatchObject({ paymentIntentId: 'pi_test_2' });
  });

  it('reports a missing payment intent as null rather than inventing one', () => {
    // The handler warns and declines to fulfil on this; it must be able to
    // tell the case apart, so nothing is fabricated here.
    expect(
      checkoutCompletionOf(sessionOf({ payment_intent: null })),
    ).toMatchObject({ paymentIntentId: null });
  });
});
