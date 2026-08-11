import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock';
import {
  BILLING_MODES,
  BILLING_REASONS,
  IDEMPOTENCY_KEYS,
  INVOICE_STATUSES,
  METADATA_KEYS,
  PAYMENT_STATUSES,
  STRIPE_API_VERSION,
  STRIPE_ERROR_TYPES,
  STRIPE_OPERATIONS,
  StripeOperation,
  SUBSCRIPTION_STATUSES,
} from '../stripe.constants';
import { StripeAdapterError } from '../stripe.error';
import { StripeService } from '../interfaces/stripe-adapter.interface';
import {
  AttachPaymentMethodParams,
  CancelSubscriptionParams,
  CreateCustomerParams,
  CreateOneTimePaymentParams,
  CreatePriceParams,
  CreateProductParams,
  CreateSubscriptionParams,
  PriceInterval,
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
import { constructEventFromSecrets, signTestPayload } from '../webhook-signature';

export type FakeFailureKind = 'rate_limit' | 'invalid_request';

export const FAKE_WEBHOOK_SECRET = 'whsec_fake_signing_secret';

@Injectable()
export class FakeStripeAdapter extends StripeService {
  private readonly customers = new Map<string, StripeCustomer>();
  private readonly subscriptions = new Map<string, StripeSubscription>();
  private lastUpdate: UpdateSubscriptionParams | null = null;
  private readonly products = new Map<string, StripeProduct>();
  private readonly prices = new Map<string, StripePrice>();
  private readonly paymentMethods = new Map<string, StripePaymentMethod>();
  private readonly invoices = new Map<string, StripeInvoice>();
  private readonly payments = new Map<string, StripePayment>();
  private readonly idempotency = new Map<string, string>();
  private readonly failures = new Map<StripeOperation, FakeFailureKind[]>();
  private readonly queuedPaymentStatuses: string[] = [];
  private sequence = 0;

  constructor(
    private readonly clock: Clock,
    private readonly webhookSecrets: string[] = [FAKE_WEBHOOK_SECRET],
  ) {
    super();
  }

  get customerCount(): number {
    return this.customers.size;
  }

  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  get paymentCount(): number {
    return this.payments.size;
  }

  failNext(operation: StripeOperation, kind: FakeFailureKind): void {
    const queued = this.failures.get(operation) ?? [];
    this.failures.set(operation, [...queued, kind]);
  }

  expireIdempotencyKeys(): void {
    this.idempotency.clear();
  }

  answerNextPaymentWith(status: string): void {
    this.queuedPaymentStatuses.push(status);
  }

  lastSubscriptionUpdate(): UpdateSubscriptionParams | null {
    return this.lastUpdate;
  }

  issueInvoiceFor(subscriptionId: string, overrides: Partial<StripeInvoice> = {}): StripeInvoice {
    const subscription = this.require(this.subscriptions.get(subscriptionId), 'subscription');
    const price = subscription.priceId ? this.prices.get(subscription.priceId) : undefined;
    const invoice: StripeInvoice = {
      ...this.issueInvoice(subscription.customerId, price),
      subscriptionId,
      ...overrides,
    };

    this.invoices.set(invoice.id, invoice);

    return invoice;
  }

  signPayload(payload: Record<string, unknown>): { rawBody: Buffer; signature: string } {
    return this.signPayloadWith(payload, this.webhookSecrets[0]);
  }

  signPayloadWith(
    payload: Record<string, unknown>,
    secret: string,
  ): { rawBody: Buffer; signature: string } {
    const body = JSON.stringify(payload);

    return {
      rawBody: Buffer.from(body, 'utf8'),
      signature: signTestPayload(body, secret, this.clock.now()),
    };
  }

  buildEventPayload(type: string, object: Record<string, unknown>): Record<string, unknown> {
    return {
      id: this.nextId('evt'),
      object: 'event',
      type,
      api_version: STRIPE_API_VERSION,
      created: Math.floor(this.clock.now().getTime() / 1000),
      data: { object },
    };
  }

  async createCustomer(params: CreateCustomerParams): Promise<StripeCustomer> {
    this.guard(STRIPE_OPERATIONS.createCustomer);

    const key = IDEMPOTENCY_KEYS.customer(params.userId);
    const existing = this.adopt(key, this.customers);
    if (existing) return existing;

    const customer: StripeCustomer = {
      id: this.nextId('cus'),
      email: params.email,
      defaultPaymentMethodId: null,
      metadata: { [METADATA_KEYS.userId]: params.userId },
    };

    this.customers.set(customer.id, customer);
    this.idempotency.set(key, customer.id);

    return customer;
  }

  async retrieveCustomer(customerId: string): Promise<StripeCustomer | null> {
    this.guard(STRIPE_OPERATIONS.retrieveCustomer);

    return this.customers.get(customerId) ?? null;
  }

  async findCustomerByUserId(userId: string): Promise<StripeCustomer | null> {
    this.guard(STRIPE_OPERATIONS.findCustomerByUserId);

    const match = [...this.customers.values()].find(
      (c) => c.metadata[METADATA_KEYS.userId] === userId,
    );

    return match ?? null;
  }

  async createSubscription(params: CreateSubscriptionParams): Promise<StripeSubscription> {
    this.guard(STRIPE_OPERATIONS.createSubscription);

    const key = IDEMPOTENCY_KEYS.subscription(params.subscriptionId);
    const existing = this.adopt(key, this.subscriptions);
    if (existing) return existing;

    const price = this.prices.get(params.priceId);
    const invoice = this.issueInvoice(params.customerId, price);

    const subscription: StripeSubscription = {
      id: this.nextId('sub'),
      customerId: params.customerId,
      status: SUBSCRIPTION_STATUSES.active,
      priceId: params.priceId,
      productId: price?.productId ?? null,
      currentPeriodEnd: this.periodEnd(price?.interval ?? 'month'),
      cancelAtPeriodEnd: false,
      billingMode: BILLING_MODES.flexible,
      latestInvoiceId: invoice.id,
      metadata: {
        [METADATA_KEYS.userId]: params.userId,
        [METADATA_KEYS.subscriptionId]: params.subscriptionId,
      },
    };

    this.subscriptions.set(subscription.id, subscription);
    this.invoices.set(invoice.id, { ...invoice, subscriptionId: subscription.id });
    this.idempotency.set(key, subscription.id);

    return subscription;
  }

  async retrieveSubscription(subscriptionId: string): Promise<StripeSubscription | null> {
    this.guard(STRIPE_OPERATIONS.retrieveSubscription);

    return this.subscriptions.get(subscriptionId) ?? null;
  }

  async findSubscriptionByLocalId(localId: string): Promise<StripeSubscription | null> {
    this.guard(STRIPE_OPERATIONS.findSubscriptionByLocalId);

    const match = [...this.subscriptions.values()].find(
      (s) => s.metadata[METADATA_KEYS.subscriptionId] === localId,
    );

    return match ?? null;
  }

  async updateSubscription(
    subscriptionId: string,
    params: UpdateSubscriptionParams,
  ): Promise<StripeSubscription> {
    this.guard(STRIPE_OPERATIONS.updateSubscription);

    this.lastUpdate = params;

    const current = this.require(this.subscriptions.get(subscriptionId), 'subscription');
    const price = params.priceId ? this.prices.get(params.priceId) : undefined;

    const updated: StripeSubscription = {
      ...current,
      priceId: params.priceId ?? current.priceId,
      productId: price ? price.productId : current.productId,
      currentPeriodEnd: price ? this.periodEnd(price.interval) : current.currentPeriodEnd,
      cancelAtPeriodEnd: params.cancelAtPeriodEnd ?? current.cancelAtPeriodEnd,
    };

    this.subscriptions.set(subscriptionId, updated);

    return updated;
  }

  async cancelSubscription(
    subscriptionId: string,
    params: CancelSubscriptionParams,
  ): Promise<StripeSubscription> {
    this.guard(STRIPE_OPERATIONS.cancelSubscription);

    const current = this.require(this.subscriptions.get(subscriptionId), 'subscription');
    const updated: StripeSubscription = params.atPeriodEnd
      ? { ...current, cancelAtPeriodEnd: true }
      : { ...current, status: SUBSCRIPTION_STATUSES.canceled, cancelAtPeriodEnd: false };

    this.subscriptions.set(subscriptionId, updated);

    return updated;
  }

  async createProduct(params: CreateProductParams): Promise<StripeProduct> {
    this.guard(STRIPE_OPERATIONS.createProduct);

    const key = IDEMPOTENCY_KEYS.product(params.code);
    const existing = this.adopt(key, this.products);
    if (existing) return existing;

    const product: StripeProduct = {
      id: this.nextId('prod'),
      name: params.name,
      active: true,
      metadata: { [METADATA_KEYS.planCode]: params.code },
    };

    this.products.set(product.id, product);
    this.idempotency.set(key, product.id);

    return product;
  }

  async createPrice(params: CreatePriceParams): Promise<StripePrice> {
    this.guard(STRIPE_OPERATIONS.createPrice);

    const key = IDEMPOTENCY_KEYS.price(params.code, params.interval, params.unitAmount);
    const existing = this.adopt(key, this.prices);
    if (existing) return existing;

    const price: StripePrice = {
      id: this.nextId('price'),
      productId: params.productId,
      unitAmount: params.unitAmount,
      currency: params.currency,
      interval: params.interval,
      active: true,
      metadata: { [METADATA_KEYS.planCode]: params.code },
    };

    this.prices.set(price.id, price);
    this.idempotency.set(key, price.id);

    return price;
  }

  async archivePrice(priceId: string): Promise<StripePrice> {
    this.guard(STRIPE_OPERATIONS.archivePrice);

    const current = this.require(this.prices.get(priceId), 'price');
    const archived: StripePrice = { ...current, active: false };

    this.prices.set(priceId, archived);

    return archived;
  }

  async findPricesByPlanCode(planCode: string): Promise<StripePrice[]> {
    this.guard(STRIPE_OPERATIONS.findPricesByPlanCode);

    return [...this.prices.values()].filter(
      (price) => price.metadata[METADATA_KEYS.planCode] === planCode,
    );
  }

  async attachPaymentMethod(params: AttachPaymentMethodParams): Promise<StripePaymentMethod> {
    this.guard(STRIPE_OPERATIONS.attachPaymentMethod);

    const method: StripePaymentMethod = {
      id: params.paymentMethodId,
      customerId: params.customerId,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    };

    this.paymentMethods.set(method.id, method);

    const customer = this.customers.get(params.customerId);
    if (customer && params.setAsDefault) {
      this.customers.set(customer.id, { ...customer, defaultPaymentMethodId: method.id });
    }

    return method;
  }

  async retrievePaymentMethod(paymentMethodId: string): Promise<StripePaymentMethod | null> {
    this.guard(STRIPE_OPERATIONS.retrievePaymentMethod);

    return this.paymentMethods.get(paymentMethodId) ?? null;
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<StripePaymentMethod> {
    this.guard(STRIPE_OPERATIONS.detachPaymentMethod);

    const current = this.require(this.paymentMethods.get(paymentMethodId), 'payment method');
    const detached: StripePaymentMethod = { ...current, customerId: null };

    this.paymentMethods.set(paymentMethodId, detached);

    return detached;
  }

  async retrieveInvoice(invoiceId: string): Promise<StripeInvoice | null> {
    this.guard(STRIPE_OPERATIONS.retrieveInvoice);

    return this.invoices.get(invoiceId) ?? null;
  }

  async createOneTimePayment(params: CreateOneTimePaymentParams): Promise<StripePayment> {
    this.guard(STRIPE_OPERATIONS.createOneTimePayment);

    const key = IDEMPOTENCY_KEYS.payment(params.purchaseId);
    const existing = this.adopt(key, this.payments);
    if (existing) return existing;

    const payment: StripePayment = {
      id: this.nextId('pi'),
      status: this.takeNextPaymentStatus(),
      amount: params.amount,
      currency: params.currency,
      metadata: {
        [METADATA_KEYS.userId]: params.userId,
        [METADATA_KEYS.purchaseId]: params.purchaseId,
      },
    };

    this.payments.set(payment.id, payment);
    this.idempotency.set(key, payment.id);

    return payment;
  }

  async retrieveOneTimePayment(paymentIntentId: string): Promise<StripePayment | null> {
    this.guard(STRIPE_OPERATIONS.retrieveOneTimePayment);

    return this.payments.get(paymentIntentId) ?? null;
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): StripeWebhookEvent {
    this.guard(STRIPE_OPERATIONS.constructWebhookEvent);

    return constructEventFromSecrets(rawBody, signature, this.webhookSecrets, this.clock.now());
  }

  private guard(operation: StripeOperation): void {
    const queued = this.failures.get(operation);
    if (!queued?.length) return;

    const kind = queued.shift() as FakeFailureKind;

    throw kind === 'rate_limit'
      ? new StripeAdapterError(
          `${operation} failed: Too many requests`,
          'retryable',
          STRIPE_ERROR_TYPES.rateLimit,
          'req_fake_rate_limit',
        )
      : new StripeAdapterError(
          `${operation} failed: Invalid request`,
          'permanent',
          STRIPE_ERROR_TYPES.invalidRequest,
          'req_fake_invalid_request',
        );
  }

  private takeNextPaymentStatus(): string {
    return this.queuedPaymentStatuses.shift() ?? PAYMENT_STATUSES.succeeded;
  }

  private adopt<T>(key: string, store: Map<string, T>): T | null {
    const id = this.idempotency.get(key);

    return id ? (store.get(id) ?? null) : null;
  }

  private require<T>(value: T | undefined, label: string): T {
    if (value) return value;

    throw new StripeAdapterError(
      `No such ${label}`,
      'permanent',
      STRIPE_ERROR_TYPES.invalidRequest,
      'req_fake_missing',
    );
  }

  private issueInvoice(customerId: string, price: StripePrice | undefined): StripeInvoice {
    const amount = price?.unitAmount ?? 0;

    return {
      id: this.nextId('in'),
      customerId,
      subscriptionId: null,
      status: INVOICE_STATUSES.paid,
      billingReason: BILLING_REASONS.subscriptionCreate,
      amountDue: amount,
      amountPaid: amount,
      currency: price?.currency ?? 'usd',
      periodStart: this.clock.now(),
      periodEnd: this.periodEnd(price?.interval ?? 'month'),
      metadata: {},
    };
  }

  private periodEnd(interval: PriceInterval | null): Date | null {
    if (!interval) return null;

    const from = this.clock.now();
    const months = interval === 'year' ? 12 : 1;

    return new Date(
      Date.UTC(
        from.getUTCFullYear(),
        from.getUTCMonth() + months,
        from.getUTCDate(),
        from.getUTCHours(),
        from.getUTCMinutes(),
        from.getUTCSeconds(),
        from.getUTCMilliseconds(),
      ),
    );
  }

  private nextId(prefix: string): string {
    this.sequence += 1;

    return `${prefix}_fake_${this.sequence}`;
  }
}
