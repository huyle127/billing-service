import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { STRIPE_OPERATIONS } from './stripe.constants';
import { classifyStripeError, StripeAdapterError } from './stripe.error';

const raw = { message: 'boom', requestId: 'req_123' };

describe('classifyStripeError', () => {
  it('treats transport and capacity failures as retryable', () => {
    const retryable = [
      new Stripe.errors.StripeConnectionError(raw),
      new Stripe.errors.StripeAPIError(raw),
      new Stripe.errors.StripeRateLimitError(raw),
    ];

    for (const error of retryable) {
      const classified = classifyStripeError(error, STRIPE_OPERATIONS.createCustomer);

      expect(classified.verdict).toBe('retryable');
    }
  });

  it('treats a request Stripe refused as permanent', () => {
    const permanent = [
      new Stripe.errors.StripeInvalidRequestError(raw),
      new Stripe.errors.StripeAuthenticationError(raw),
      new Stripe.errors.StripePermissionError(raw),
      new Stripe.errors.StripeCardError(raw),
      new Stripe.errors.StripeIdempotencyError(raw),
      new Stripe.errors.StripeSignatureVerificationError('sig', 'body', raw),
    ];

    for (const error of permanent) {
      const classified = classifyStripeError(error, STRIPE_OPERATIONS.createSubscription);

      expect(classified.verdict).toBe('permanent');
    }
  });

  it('treats an unrecognised failure as permanent rather than retrying it blind', () => {
    const failure = new Error('something else entirely');
    const classified = classifyStripeError(failure, STRIPE_OPERATIONS.retrieveInvoice);

    expect(classified.verdict).toBe('permanent');
    expect(classified.retryable).toBe(false);
    expect(classified.stripeErrorType).toBe('unknown');
  });

  it('preserves the Stripe error type and request id', () => {
    const failure = new Stripe.errors.StripeRateLimitError(raw);
    const classified = classifyStripeError(failure, STRIPE_OPERATIONS.createPrice);

    expect(classified.requestId).toBe('req_123');
    expect(classified.stripeErrorType).toBe('StripeRateLimitError');
    expect(classified.message).toContain('boom');
  });

  it('renders through the error envelope as a gateway fault', () => {
    const failure = new Stripe.errors.StripeAPIError(raw);
    const classified = classifyStripeError(failure, STRIPE_OPERATIONS.createPrice);

    expect(classified).toBeInstanceOf(StripeAdapterError);
    expect(classified.code).toBe('INTERNAL_ERROR');
    expect(classified.status).toBe(502);
    expect(classified.details).toEqual({ requestId: 'req_123' });
  });

  it('does not reclassify an error it has already classified', () => {
    const failure = new Stripe.errors.StripeConnectionError(raw);
    const once = classifyStripeError(failure, STRIPE_OPERATIONS.createPrice);

    expect(classifyStripeError(once, STRIPE_OPERATIONS.archivePrice)).toBe(once);
  });
});
