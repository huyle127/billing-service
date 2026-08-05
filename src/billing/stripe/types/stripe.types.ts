export type StripeMetadata = Record<string, string>;

export type BillingMode = 'flexible' | 'classic';

export type PriceInterval = 'month' | 'year';

export type ProrationBehavior = 'create_prorations' | 'none';

export interface StripeCustomer {
  id: string;
  email: string | null;
  defaultPaymentMethodId: string | null;
  metadata: StripeMetadata;
}

export interface StripeSubscription {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  productId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  billingMode: BillingMode;
  latestInvoiceId: string | null;
  metadata: StripeMetadata;
}

export interface StripeProduct {
  id: string;
  name: string;
  active: boolean;
  metadata: StripeMetadata;
}

export interface StripePrice {
  id: string;
  productId: string;
  unitAmount: number | null;
  currency: string;
  interval: PriceInterval | null;
  active: boolean;
  metadata: StripeMetadata;
}

export interface StripePaymentMethod {
  id: string;
  customerId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface StripeInvoice {
  id: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  periodEnd: Date | null;
  metadata: StripeMetadata;
}

export interface StripePayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  metadata: StripeMetadata;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  createdAt: Date;
  apiVersion: string | null;
  objectId: string | null;
  payload: Record<string, unknown>;
}

export interface CreateCustomerParams {
  userId: string;
  email: string;
  name?: string;
}

export interface CreateSubscriptionParams {
  subscriptionId: string;
  userId: string;
  customerId: string;
  priceId: string;
  defaultPaymentMethodId?: string;
}

export interface UpdateSubscriptionParams {
  priceId?: string;
  defaultPaymentMethodId?: string;
  prorationBehavior?: ProrationBehavior;
}

export interface CancelSubscriptionParams {
  atPeriodEnd: boolean;
}

export interface CreateProductParams {
  code: string;
  name: string;
  description?: string;
}

export interface CreatePriceParams {
  code: string;
  productId: string;
  unitAmount: number;
  currency: string;
  interval: PriceInterval | null;
}

export interface AttachPaymentMethodParams {
  customerId: string;
  paymentMethodId: string;
  setAsDefault: boolean;
}

export interface CreateOneTimePaymentParams {
  purchaseId: string;
  userId: string;
  customerId: string;
  paymentMethodId: string;
  amount: number;
  currency: string;
  description?: string;
}
