export const LEDGER_TRANSACTION = { maxWait: 15_000, timeout: 20_000 };

export const DECLINE_COUNTER = 'credits.consume.declined';

export const DECLINE_REASON_LABEL = 'reason';

export const DECLINE_REASONS = {
  insufficientCredits: 'INSUFFICIENT_CREDITS',
  billingFrozen: 'BILLING_FROZEN',
} as const;

export type DeclineReason = (typeof DECLINE_REASONS)[keyof typeof DECLINE_REASONS];
