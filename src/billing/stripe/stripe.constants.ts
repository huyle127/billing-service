import Stripe from 'stripe';
import { PriceInterval } from './types/stripe.types';

export const STRIPE_API_VERSION = '2026-07-29.dahlia';

export const STRIPE_OPERATIONS = {
  createCustomer: 'createCustomer',
  retrieveCustomer: 'retrieveCustomer',
  findCustomerByUserId: 'findCustomerByUserId',
  createSubscription: 'createSubscription',
  retrieveSubscription: 'retrieveSubscription',
  findSubscriptionByLocalId: 'findSubscriptionByLocalId',
  updateSubscription: 'updateSubscription',
  cancelSubscription: 'cancelSubscription',
  createProduct: 'createProduct',
  createPrice: 'createPrice',
  archivePrice: 'archivePrice',
  findPricesByPlanCode: 'findPricesByPlanCode',
  attachPaymentMethod: 'attachPaymentMethod',
  detachPaymentMethod: 'detachPaymentMethod',
  retrievePaymentMethod: 'retrievePaymentMethod',
  retrieveInvoice: 'retrieveInvoice',
  createOneTimePayment: 'createOneTimePayment',
  retrieveOneTimePayment: 'retrieveOneTimePayment',
  constructWebhookEvent: 'constructWebhookEvent',
} as const;

export type StripeOperation = (typeof STRIPE_OPERATIONS)[keyof typeof STRIPE_OPERATIONS];

export const METADATA_KEYS = {
  userId: 'userId',
  subscriptionId: 'subscriptionId',
  purchaseId: 'purchaseId',
  planCode: 'code',
} as const;

export const IDEMPOTENCY_KEYS = {
  customer: (userId: string): string => `customer:${userId}`,
  subscription: (subscriptionId: string): string => `subscription:${subscriptionId}`,
  product: (planCode: string): string => `product:${planCode}`,
  price: (planCode: string, interval: PriceInterval | null, unitAmount: number): string =>
    `price:${planCode}:${interval ?? 'once'}:${unitAmount}`,
  payment: (purchaseId: string): string => `payment:${purchaseId}`,
} as const;

export const BILLING_MODES = {
  flexible: 'flexible',
  classic: 'classic',
} as const;

export const SUBSCRIPTION_STATUSES = {
  active: 'active',
  canceled: 'canceled',
} as const;

export const INVOICE_STATUSES = {
  paid: 'paid',
} as const;

export const BILLING_REASONS = {
  subscriptionCreate: 'subscription_create',
  subscriptionCycle: 'subscription_cycle',
  subscriptionUpdate: 'subscription_update',
} as const;

export const PAYMENT_STATUSES = {
  succeeded: 'succeeded',
  requiresAction: 'requires_action',
  requiresPaymentMethod: 'requires_payment_method',
} as const;

export const STRIPE_ERROR_TYPES = {
  rateLimit: Stripe.errors.StripeRateLimitError.name,
  invalidRequest: Stripe.errors.StripeInvalidRequestError.name,
  signatureVerification: Stripe.errors.StripeSignatureVerificationError.name,
  unknown: 'unknown',
} as const;

export function metadataQuery(key: keyof typeof METADATA_KEYS, value: string): string {
  return `metadata['${METADATA_KEYS[key]}']:'${value}'`;
}
