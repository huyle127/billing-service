import {
  AttachPaymentMethodParams,
  CancelSubscriptionParams,
  CreateCustomerParams,
  CreateOneTimePaymentParams,
  CreatePriceParams,
  CreateProductParams,
  CreateSubscriptionParams,
  StripeCustomer,
  StripeInvoice,
  StripePayment,
  StripePaymentMethod,
  StripePrice,
  StripeProduct,
  StripeSubscription,
  StripeWebhookEvent,
  UpdateSubscriptionParams,
} from '../types/stripe.types';

export abstract class StripeService {
  abstract createCustomer(params: CreateCustomerParams): Promise<StripeCustomer>;

  abstract retrieveCustomer(customerId: string): Promise<StripeCustomer | null>;

  abstract findCustomerByUserId(userId: string): Promise<StripeCustomer | null>;

  abstract createSubscription(params: CreateSubscriptionParams): Promise<StripeSubscription>;

  abstract retrieveSubscription(subscriptionId: string): Promise<StripeSubscription | null>;

  abstract findSubscriptionByLocalId(localId: string): Promise<StripeSubscription | null>;

  abstract updateSubscription(
    subscriptionId: string,
    params: UpdateSubscriptionParams,
  ): Promise<StripeSubscription>;

  abstract cancelSubscription(
    subscriptionId: string,
    params: CancelSubscriptionParams,
  ): Promise<StripeSubscription>;

  abstract createProduct(params: CreateProductParams): Promise<StripeProduct>;

  abstract createPrice(params: CreatePriceParams): Promise<StripePrice>;

  abstract archivePrice(priceId: string): Promise<StripePrice>;

  abstract attachPaymentMethod(params: AttachPaymentMethodParams): Promise<StripePaymentMethod>;

  abstract detachPaymentMethod(paymentMethodId: string): Promise<StripePaymentMethod>;

  abstract retrieveInvoice(invoiceId: string): Promise<StripeInvoice | null>;

  abstract createOneTimePayment(params: CreateOneTimePaymentParams): Promise<StripePayment>;

  abstract constructWebhookEvent(rawBody: Buffer, signature: string): StripeWebhookEvent;
}
