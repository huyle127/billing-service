export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export const WEBHOOK_EVENT_TYPES = {
  subscriptionTrialWillEnd: 'customer.subscription.trial_will_end',
} as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[keyof typeof WEBHOOK_EVENT_TYPES];

export const OUTCOME_STATUSES = {
  completed: 'completed',
  deferred: 'deferred',
  failed: 'failed',
} as const;

export const WEBHOOK_REASONS = {
  deferred: (detail: string): string => `${OUTCOME_STATUSES.deferred}: ${detail}`,
  failed: (detail: string): string => `${OUTCOME_STATUSES.failed}: ${detail}`,
} as const;
