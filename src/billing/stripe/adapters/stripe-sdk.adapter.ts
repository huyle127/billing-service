import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { Clock } from '../../../common/clock/clock';
import { AppConfigService } from '../../../common/config/app-config.service';
import {
  BILLING_MODES,
  IDEMPOTENCY_KEYS,
  METADATA_KEYS,
  metadataQuery,
  STRIPE_API_VERSION,
  STRIPE_OPERATIONS,
  StripeOperation,
} from '../stripe.constants';
import { classifyStripeError, isMissingResource } from '../stripe.error';
import { StripeService } from '../interfaces/stripe-adapter.interface';
import {
  AttachPaymentMethodParams,
  BillingMode,
  CancelSubscriptionParams,
  CreateCustomerParams,
  CreateOneTimePaymentParams,
  CreatePriceParams,
  CreateProductParams,
  CreateSubscriptionParams,
  PriceInterval,
  StripeCustomer,
  StripeInvoice,
  StripeMetadata,
  StripePayment,
  StripePaymentMethod,
  StripePrice,
  StripeProduct,
  StripeSubscription,
  StripeWebhookEvent,
  UpdateSubscriptionParams,
} from '../types/stripe.types';
import { constructEventFromSecrets } from '../webhook-signature';

@Injectable()
export class StripeSdkAdapter extends StripeService {
  private readonly logger = new Logger(StripeSdkAdapter.name);
  private readonly client: Stripe;

  constructor(
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {
    super();
    this.client = new Stripe(config.stripeSecretKey, { apiVersion: STRIPE_API_VERSION });
  }

  get apiVersion(): string {
    return STRIPE_API_VERSION;
  }

  async createCustomer(params: CreateCustomerParams): Promise<StripeCustomer> {
    const customer = await this.call(STRIPE_OPERATIONS.createCustomer, () =>
      this.client.customers.create(
        {
          email: params.email,
          name: params.name,
          metadata: { [METADATA_KEYS.userId]: params.userId },
        },
        { idempotencyKey: IDEMPOTENCY_KEYS.customer(params.userId) },
      ),
    );

    return this.toCustomer(customer);
  }

  async retrieveCustomer(customerId: string): Promise<StripeCustomer | null> {
    const customer = await this.retrieveOrNull(STRIPE_OPERATIONS.retrieveCustomer, () =>
      this.client.customers.retrieve(customerId),
    );

    if (!customer || customer.deleted) return null;

    return this.toCustomer(customer);
  }

  async findCustomerByUserId(userId: string): Promise<StripeCustomer | null> {
    const found = await this.call(STRIPE_OPERATIONS.findCustomerByUserId, () =>
      this.client.customers.search({ query: metadataQuery('userId', userId), limit: 1 }),
    );

    const [customer] = found.data;

    return customer ? this.toCustomer(customer) : null;
  }

  async createSubscription(params: CreateSubscriptionParams): Promise<StripeSubscription> {
    const subscription = await this.call(STRIPE_OPERATIONS.createSubscription, () =>
      this.client.subscriptions.create(
        {
          customer: params.customerId,
          items: [{ price: params.priceId }],
          default_payment_method: params.defaultPaymentMethodId,
          metadata: {
            [METADATA_KEYS.userId]: params.userId,
            [METADATA_KEYS.subscriptionId]: params.subscriptionId,
          },
        },
        { idempotencyKey: IDEMPOTENCY_KEYS.subscription(params.subscriptionId) },
      ),
    );

    return this.toSubscription(subscription);
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription | null> {
    const subscription = await this.retrieveOrNull(STRIPE_OPERATIONS.retrieveSubscription, () =>
      this.client.subscriptions.retrieve(subscriptionId),
    );

    return subscription ? this.toSubscription(subscription) : null;
  }

  async findSubscriptionByLocalId(localId: string): Promise<StripeSubscription | null> {
    const found = await this.call(STRIPE_OPERATIONS.findSubscriptionByLocalId, () =>
      this.client.subscriptions.search({
        query: metadataQuery('subscriptionId', localId),
        limit: 1,
      }),
    );

    const [subscription] = found.data;

    return subscription ? this.toSubscription(subscription) : null;
  }

  async updateSubscription(
    subscriptionId: string,
    params: UpdateSubscriptionParams,
  ): Promise<StripeSubscription> {
    const items = params.priceId
      ? await this.replacementItems(subscriptionId, params.priceId)
      : undefined;

    const subscription = await this.call(STRIPE_OPERATIONS.updateSubscription, () =>
      this.client.subscriptions.update(subscriptionId, {
        items,
        default_payment_method: params.defaultPaymentMethodId,
        proration_behavior: params.prorationBehavior,
      }),
    );

    return this.toSubscription(subscription);
  }

  async cancelSubscription(
    subscriptionId: string,
    params: CancelSubscriptionParams,
  ): Promise<StripeSubscription> {
    const subscription = await this.call(STRIPE_OPERATIONS.cancelSubscription, () =>
      params.atPeriodEnd
        ? this.client.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
        : this.client.subscriptions.cancel(subscriptionId),
    );

    return this.toSubscription(subscription);
  }

  async createProduct(params: CreateProductParams): Promise<StripeProduct> {
    const product = await this.call(STRIPE_OPERATIONS.createProduct, () =>
      this.client.products.create(
        {
          name: params.name,
          description: params.description,
          metadata: { [METADATA_KEYS.planCode]: params.code },
        },
        { idempotencyKey: IDEMPOTENCY_KEYS.product(params.code) },
      ),
    );

    return this.toProduct(product);
  }

  async createPrice(params: CreatePriceParams): Promise<StripePrice> {
    const price = await this.call(STRIPE_OPERATIONS.createPrice, () =>
      this.client.prices.create(
        {
          product: params.productId,
          unit_amount: params.unitAmount,
          currency: params.currency,
          recurring: params.interval ? { interval: params.interval } : undefined,
          metadata: { [METADATA_KEYS.planCode]: params.code },
        },
        { idempotencyKey: IDEMPOTENCY_KEYS.price(params.code, params.unitAmount) },
      ),
    );

    return this.toPrice(price);
  }

  async archivePrice(priceId: string): Promise<StripePrice> {
    const price = await this.call(STRIPE_OPERATIONS.archivePrice, () =>
      this.client.prices.update(priceId, { active: false }),
    );

    return this.toPrice(price);
  }

  async attachPaymentMethod(params: AttachPaymentMethodParams): Promise<StripePaymentMethod> {
    const method = await this.call(STRIPE_OPERATIONS.attachPaymentMethod, () =>
      this.client.paymentMethods.attach(params.paymentMethodId, { customer: params.customerId }),
    );

    if (params.setAsDefault) {
      await this.call(STRIPE_OPERATIONS.attachPaymentMethod, () =>
        this.client.customers.update(params.customerId, {
          invoice_settings: { default_payment_method: method.id },
        }),
      );
    }

    return this.toPaymentMethod(method);
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<StripePaymentMethod> {
    const method = await this.call(STRIPE_OPERATIONS.detachPaymentMethod, () =>
      this.client.paymentMethods.detach(paymentMethodId),
    );

    return this.toPaymentMethod(method);
  }

  async retrieveInvoice(invoiceId: string): Promise<StripeInvoice | null> {
    const invoice = await this.retrieveOrNull(STRIPE_OPERATIONS.retrieveInvoice, () =>
      this.client.invoices.retrieve(invoiceId),
    );

    return invoice ? this.toInvoice(invoice) : null;
  }

  async createOneTimePayment(params: CreateOneTimePaymentParams): Promise<StripePayment> {
    const intent = await this.call(STRIPE_OPERATIONS.createOneTimePayment, () =>
      this.client.paymentIntents.create(
        {
          amount: params.amount,
          currency: params.currency,
          customer: params.customerId,
          payment_method: params.paymentMethodId,
          description: params.description,
          confirm: true,
          off_session: true,
          metadata: {
            [METADATA_KEYS.userId]: params.userId,
            [METADATA_KEYS.purchaseId]: params.purchaseId,
          },
        },
        { idempotencyKey: IDEMPOTENCY_KEYS.payment(params.purchaseId) },
      ),
    );

    return {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      metadata: this.toMetadata(intent.metadata),
    };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): StripeWebhookEvent {
    const event = constructEventFromSecrets(
      rawBody,
      signature,
      this.config.stripeWebhookSecrets,
      this.clock.now(),
    );

    if (event.apiVersion && event.apiVersion !== STRIPE_API_VERSION) {
      this.logger.warn(
        `Event ${event.id} was rendered under API version ${event.apiVersion}, ` +
          `not ${STRIPE_API_VERSION}. Check the version pinned on the Stripe webhook endpoint.`,
      );
    }

    return event;
  }

  private async replacementItems(
    subscriptionId: string,
    priceId: string,
  ): Promise<Stripe.SubscriptionUpdateParams.Item[]> {
    const current = await this.call(STRIPE_OPERATIONS.updateSubscription, () =>
      this.client.subscriptions.retrieve(subscriptionId),
    );

    return [{ id: current.items.data[0].id, price: priceId }];
  }

  private async call<T>(operation: StripeOperation, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw classifyStripeError(error, operation);
    }
  }

  private async retrieveOrNull<T>(
    operation: StripeOperation,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (isMissingResource(error)) return null;
      throw classifyStripeError(error, operation);
    }
  }

  private toCustomer(customer: Stripe.Customer): StripeCustomer {
    const defaultMethod = customer.invoice_settings?.default_payment_method;

    return {
      id: customer.id,
      email: customer.email,
      defaultPaymentMethodId: this.toId(defaultMethod),
      metadata: this.toMetadata(customer.metadata),
    };
  }

  private toSubscription(subscription: Stripe.Subscription): StripeSubscription {
    const item = subscription.items.data[0];

    return {
      id: subscription.id,
      customerId: this.toId(subscription.customer) as string,
      status: subscription.status,
      priceId: item?.price.id ?? null,
      productId: item ? this.toId(item.price.product) : null,
      currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      billingMode: this.toBillingMode(subscription.billing_mode.type),
      latestInvoiceId: this.toId(subscription.latest_invoice),
      metadata: this.toMetadata(subscription.metadata),
    };
  }

  private toBillingMode(mode: string): BillingMode {
    return mode === BILLING_MODES.classic ? BILLING_MODES.classic : BILLING_MODES.flexible;
  }

  private toProduct(product: Stripe.Product): StripeProduct {
    return {
      id: product.id,
      name: product.name,
      active: product.active,
      metadata: this.toMetadata(product.metadata),
    };
  }

  private toPrice(price: Stripe.Price): StripePrice {
    return {
      id: price.id,
      productId: this.toId(price.product) as string,
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: (price.recurring?.interval as PriceInterval) ?? null,
      active: price.active,
      metadata: this.toMetadata(price.metadata),
    };
  }

  private toPaymentMethod(method: Stripe.PaymentMethod): StripePaymentMethod {
    return {
      id: method.id,
      customerId: this.toId(method.customer),
      brand: method.card?.brand ?? null,
      last4: method.card?.last4 ?? null,
      expMonth: method.card?.exp_month ?? null,
      expYear: method.card?.exp_year ?? null,
    };
  }

  private toInvoice(invoice: Stripe.Invoice): StripeInvoice {
    const subscription = invoice.parent?.subscription_details?.subscription;

    return {
      id: invoice.id as string,
      customerId: this.toId(invoice.customer),
      subscriptionId: this.toId(subscription),
      status: invoice.status,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      periodEnd: new Date(invoice.period_end * 1000),
      metadata: this.toMetadata(invoice.metadata),
    };
  }

  private toId(value: string | { id: string } | null | undefined): string | null {
    if (!value) return null;

    return typeof value === 'string' ? value : value.id;
  }

  private toMetadata(metadata: Stripe.Metadata | null): StripeMetadata {
    return metadata ?? {};
  }
}
