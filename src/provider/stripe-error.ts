import { HttpStatus } from '@nestjs/common';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';

/**
 * The shape of a Stripe SDK error, narrowed structurally so this mapping can be
 * tested without the SDK.
 */
interface StripeLikeError {
  type?: string;
  code?: string;
  message?: string;
  statusCode?: number;
}

function asStripeError(error: unknown): StripeLikeError | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const candidate = error as StripeLikeError;
  return typeof candidate.type === 'string' ? candidate : null;
}

/**
 * Translates a Stripe failure into the standard error contract, distinguishing
 * what the caller can correct from what they cannot. Raw SDK error shapes never
 * reach an API caller.
 *
 * The distinction that matters operationally: a declined card is the user's
 * problem and retrying the same request will fail the same way, whereas a
 * connection or API error is ours and the request may well succeed later.
 */
export function mapStripeError(error: unknown): BillingException {
  const stripeError = asStripeError(error);

  if (!stripeError) {
    return new BillingException(
      ErrorCode.StripeApiError,
      'The billing provider returned an unexpected error.',
      HttpStatus.BAD_GATEWAY,
    );
  }

  const detail = { providerCode: stripeError.code, type: stripeError.type };

  switch (stripeError.type) {
    // Client-correctable: the payment instrument was refused.
    case 'StripeCardError':
      return new BillingException(
        ErrorCode.PaymentFailed,
        stripeError.message ?? 'The card was declined.',
        HttpStatus.PAYMENT_REQUIRED,
        detail,
      );

    // Client-correctable: the payment method itself is unusable.
    case 'StripeInvalidRequestError':
      return isPaymentMethodProblem(stripeError.code)
        ? new BillingException(
            ErrorCode.InvalidPaymentMethod,
            stripeError.message ?? 'The payment method is not valid.',
            HttpStatus.BAD_REQUEST,
            detail,
          )
        : new BillingException(
            ErrorCode.StripeApiError,
            'The billing provider rejected the request.',
            HttpStatus.BAD_REQUEST,
            detail,
          );

    // Provider or transport failures: not the caller's fault, and no local
    // billing state has been committed.
    case 'StripeConnectionError':
    case 'StripeAPIError':
    case 'StripeRateLimitError':
      return new BillingException(
        ErrorCode.StripeApiError,
        'The billing provider is currently unavailable.',
        HttpStatus.SERVICE_UNAVAILABLE,
        detail,
      );

    case 'StripeAuthenticationError':
      return new BillingException(
        ErrorCode.StripeApiError,
        'The billing provider rejected our credentials.',
        HttpStatus.SERVICE_UNAVAILABLE,
        detail,
      );

    default:
      return new BillingException(
        ErrorCode.StripeApiError,
        'The billing provider returned an unexpected error.',
        HttpStatus.BAD_GATEWAY,
        detail,
      );
  }
}

function isPaymentMethodProblem(code: string | undefined): boolean {
  return (
    code === 'payment_method_unactivated' ||
    code === 'payment_method_unexpected_state' ||
    code === 'resource_missing_payment_method' ||
    code === 'invalid_source_usage'
  );
}
