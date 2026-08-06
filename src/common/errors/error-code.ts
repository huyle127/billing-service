export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
