export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

export const WEBHOOK_EVENT_TYPES = {
  customerCreated: 'customer.created',
  subscriptionCreated: 'customer.subscription.created',
  subscriptionUpdated: 'customer.subscription.updated',
  subscriptionDeleted: 'customer.subscription.deleted',
  invoicePaid: 'invoice.paid',
  invoicePaymentFailed: 'invoice.payment_failed',
  paymentMethodAttached: 'payment_method.attached',
  paymentMethodDetached: 'payment_method.detached',
} as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[keyof typeof WEBHOOK_EVENT_TYPES];

export const RESOLVED = 'resolved';

export const SUPERSEDED = 'superseded';

export const OUTCOME_STATUSES = {
  completed: 'completed',
  deferred: 'deferred',
  failed: 'failed',
} as const;

export const WEBHOOK_REASONS = {
  deferred: (detail: string): string => `${OUTCOME_STATUSES.deferred}: ${detail}`,
  failed: (detail: string): string => `${OUTCOME_STATUSES.failed}: ${detail}`,
} as const;

export const DEFERRALS = {
  noObjectId: 'The event carries no object id',
  goneFromStripe: (objectId: string): string => `Stripe no longer holds ${objectId}`,
  unlabelled: (objectId: string): string => `${objectId} carries no local id in its metadata`,
  noLocalSubscription: (localId: string): string => `No subscription ${localId} exists locally`,
  noLocalCustomer: (userId: string): string => `User ${userId} has no billing customer`,
  unattached: (objectId: string): string => `${objectId} belongs to no Stripe customer`,
  noCustomerOwner: (customerId: string): string => `No local user holds customer ${customerId}`,
  noPlanForPrice: (priceId: string): string => `No active plan is priced at ${priceId}`,
  noInvoiceSubscription: (invoiceId: string): string =>
    `Invoice ${invoiceId} names no subscription`,
} as const;
