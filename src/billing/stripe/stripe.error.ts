import { HttpStatus } from '@nestjs/common';
import Stripe from 'stripe';
import { DomainException } from '../../common/errors/domain.exception';
import { STRIPE_ERROR_TYPES, StripeOperation } from './stripe.constants';

export type StripeFailureVerdict = 'retryable' | 'permanent';

export class StripeAdapterError extends DomainException {
  constructor(
    message: string,
    readonly verdict: StripeFailureVerdict,
    readonly stripeErrorType: string,
    readonly requestId: string | null,
  ) {
    super('INTERNAL_ERROR', message, HttpStatus.BAD_GATEWAY, { requestId });
  }

  get retryable(): boolean {
    return this.verdict === 'retryable';
  }
}

const RETRYABLE_ERRORS = [
  Stripe.errors.StripeConnectionError,
  Stripe.errors.StripeAPIError,
  Stripe.errors.StripeRateLimitError,
];

function verdictOf(error: unknown): StripeFailureVerdict {
  return RETRYABLE_ERRORS.some((type) => error instanceof type) ? 'retryable' : 'permanent';
}

export function classifyStripeError(
  error: unknown,
  operation: StripeOperation,
): StripeAdapterError {
  if (error instanceof StripeAdapterError) return error;

  if (!(error instanceof Stripe.errors.StripeError)) {
    const message = error instanceof Error ? error.message : String(error);

    return new StripeAdapterError(
      `${operation} failed: ${message}`,
      'permanent',
      STRIPE_ERROR_TYPES.unknown,
      null,
    );
  }

  return new StripeAdapterError(
    `${operation} failed: ${error.message}`,
    verdictOf(error),
    error.type,
    error.requestId ?? null,
  );
}
