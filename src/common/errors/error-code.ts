/**
 * Machine-readable error codes. Every handled error returned by the API carries
 * exactly one of these (`billing-history` → "API Errors Are Standardised").
 *
 * The ten codes the error contract must distinguish are grouped first; the
 * remainder cover the transport-level cases every HTTP service needs.
 */
export enum ErrorCode {
  // The ten cases the error contract must distinguish.
  InvalidPaymentMethod = 'INVALID_PAYMENT_METHOD',
  PaymentFailed = 'PAYMENT_FAILED',
  MissingStripeCustomer = 'MISSING_STRIPE_CUSTOMER',
  InvalidSubscriptionState = 'INVALID_SUBSCRIPTION_STATE',
  DuplicateEvent = 'DUPLICATE_EVENT',
  InvalidWebhookSignature = 'INVALID_WEBHOOK_SIGNATURE',
  InsufficientCredits = 'INSUFFICIENT_CREDITS',
  InvalidPlanOrCycle = 'INVALID_PLAN_OR_CYCLE',
  StripeApiError = 'STRIPE_API_ERROR',
  DatabaseTransactionFailed = 'DATABASE_TRANSACTION_FAILED',

  // Transport-level cases.
  ValidationFailed = 'VALIDATION_FAILED',
  Unauthenticated = 'UNAUTHENTICATED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  RateLimited = 'RATE_LIMITED',
  InternalError = 'INTERNAL_ERROR',
}
