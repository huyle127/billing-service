import { HttpStatus } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { BillingException } from '../../common/errors/billing.exception';
import { ErrorCode } from '../../common/errors/error-code';
import { SubscriptionStatus } from '../../generated/prisma/enums';
import {
  BillingEvent,
  BillingProvider,
  ChangeSubscriptionPriceInput,
  CreateCheckoutSessionInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  ProviderCheckoutSession,
  ProviderCustomer,
  ProviderEvent,
  ProviderInvoice,
  ProviderCheckoutCompletion,
  ProviderPaymentMethod,
  ProviderSubscription,
} from '../billing-provider';

const FAKE_SIGNING_SECRET = 'whsec_fake';

/** A delivery as it arrives at the endpoint: exact bytes plus a signature. */
export interface FakeDelivery {
  eventId: string;
  payload: Buffer;
  signature: string;
}

/**
 * An in-memory {@link BillingProvider} for integration tests.
 *
 * The interesting inputs in this system are provider events and the
 * interesting assertions are database state, so tests fake the provider and use
 * a real database rather than the other way round (design D8).
 *
 * It keeps enough provider-side state to answer the questions tests actually
 * ask — chiefly "was anything left orphaned at the provider" — and records
 * every call so the two cancellation modes can be told apart.
 */
export class FakeBillingProvider implements BillingProvider {
  readonly customers = new Map<string, ProviderCustomer>();
  readonly subscriptions = new Map<string, ProviderSubscription>();
  readonly checkoutSessions = new Map<string, ProviderCheckoutSession>();

  /** Sessions already created for a given attempt, so a repeat replays them. */
  readonly sessionsByIdempotencyKey = new Map<
    string,
    ProviderCheckoutSession
  >();

  /** Payment methods the provider holds, attached or not, by identifier. */
  readonly paymentMethods = new Map<string, ProviderPaymentMethod>();

  /** Which method each customer is charged on, mirroring invoice settings. */
  readonly defaultPaymentMethods = new Map<string, string>();

  /** Events prepared for delivery, by provider event id. */
  readonly events = new Map<string, ProviderEvent>();

  /**
   * Invoices as a **retrieval** reports them, by identifier — carrying the
   * fields a delivery omits.
   *
   * The gap between this and what {@link invoiceFor} hands to a delivery is the
   * point of it: Stripe populates `payments` only when asked, so the payment
   * identifier is on the retrieved invoice and never on the event. A test that
   * needs the provider to report no identifier at all mutates the entry here,
   * the same way tests reach into `subscriptions` or `checkoutSessions`.
   */
  readonly invoices = new Map<string, ProviderInvoice>();

  /**
   * The billing interval each price recurs on, so period boundaries look like
   * the ones Stripe would report. A test that registers the annual price here
   * gets a year-long billing period, which is what makes the annual/monthly
   * credit divergence observable rather than assumed.
   */
  readonly priceIntervals = new Map<string, 'month' | 'year'>();

  /** Every method call, in order, as `name` plus its first argument. */
  readonly calls: { method: string; argument: unknown }[] = [];

  /**
   * Creation timestamp stamped on subscriptions made from here on. Orphan
   * cleanup ignores subscriptions younger than its grace window, so a test that
   * wants to see cleanup act has to make one that is old enough.
   */
  createdAt?: Date;

  /** Set to make the next call of a given method throw. */
  private failures = new Map<string, Error>();

  /** What each open checkout session would subscribe the customer to. */
  private readonly pendingCheckouts = new Map<
    string,
    { customerId: string; priceId: string; metadata?: Record<string, string> }
  >();

  failNext(method: keyof BillingProvider, error: Error): void {
    this.failures.set(method, error);
  }

  /**
   * What Stripe does once a customer completes a checkout session: the
   * subscription the session was for comes into existence, with its first
   * invoice paid. Deliberately *not* something the service can trigger — a
   * checkout has no local effect until the provider reports payment, and this is
   * how a test plays the provider's part.
   */
  completeCheckout(
    sessionId: string,
    overrides: Partial<ProviderSubscription> = {},
  ): ProviderSubscription {
    const pending = this.pendingCheckouts.get(sessionId);
    if (!pending) {
      throw new Error(`No open checkout session ${sessionId}`);
    }
    this.pendingCheckouts.delete(sessionId);

    const subscription = {
      ...this.newSubscription(pending.customerId, pending.priceId),
      ...overrides,
    };
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  /** Subscriptions the provider still considers in force. */
  liveSubscriptions(): ProviderSubscription[] {
    return [...this.subscriptions.values()].filter(
      (s) =>
        s.status === SubscriptionStatus.ACTIVE ||
        s.status === SubscriptionStatus.TRIALING ||
        s.status === SubscriptionStatus.PAST_DUE,
    );
  }

  callsTo(method: keyof BillingProvider): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.argument);
  }

  reset(): void {
    this.customers.clear();
    this.subscriptions.clear();
    this.checkoutSessions.clear();
    this.sessionsByIdempotencyKey.clear();
    this.paymentMethods.clear();
    this.defaultPaymentMethods.clear();
    this.events.clear();
    this.invoices.clear();
    this.pendingCheckouts.clear();
    this.priceIntervals.clear();
    this.calls.length = 0;
    this.failures.clear();
    this.createdAt = undefined;
  }

  // --- Customer ---

  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    this.record('createCustomer', input);
    const customer: ProviderCustomer = {
      id: `cus_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      email: input.email,
    };
    this.customers.set(customer.id, customer);
    return Promise.resolve(customer);
  }

  getCustomer(customerId: string): Promise<ProviderCustomer | null> {
    this.record('getCustomer', customerId);
    return Promise.resolve(this.customers.get(customerId) ?? null);
  }

  // --- Subscription ---

  createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<ProviderSubscription> {
    this.record('createSubscription', input);
    const subscription = this.newSubscription(input.customerId, input.priceId);
    this.subscriptions.set(subscription.id, subscription);
    return Promise.resolve(subscription);
  }

  getSubscription(id: string): Promise<ProviderSubscription | null> {
    this.record('getSubscription', id);
    return Promise.resolve(this.subscriptions.get(id) ?? null);
  }

  /**
   * The retrievable form of an invoice, carrying the payment identifier that
   * the delivered form omits — the asymmetry Stripe has and this fake must
   * reproduce, or the code path that resolves the identifier is never taken.
   */
  getInvoice(providerInvoiceId: string): Promise<ProviderInvoice | null> {
    this.record('getInvoice', providerInvoiceId);
    return Promise.resolve(this.invoices.get(providerInvoiceId) ?? null);
  }

  listCustomerSubscriptions(
    customerId: string,
  ): Promise<ProviderSubscription[]> {
    this.record('listCustomerSubscriptions', customerId);
    return Promise.resolve(
      [...this.subscriptions.values()].filter(
        (s) => s.customerId === customerId,
      ),
    );
  }

  changeSubscriptionPrice(
    input: ChangeSubscriptionPriceInput,
  ): Promise<ProviderSubscription> {
    this.record('changeSubscriptionPrice', input);
    const existing = this.require(input.providerSubscriptionId);
    // Same identity, new price — the defining property of a cycle change. The
    // *billing* period restarts on the new interval, as Stripe's does; the
    // credit period is the plan's and is no business of the provider's.
    const now = new Date();
    const updated = {
      ...existing,
      priceId: input.priceId,
      currentPeriodStart: now,
      currentPeriodEnd: this.periodEnd(now, input.priceId),
    };
    this.subscriptions.set(updated.id, updated);
    return Promise.resolve(updated);
  }

  cancelSubscriptionAtPeriodEnd(id: string): Promise<ProviderSubscription> {
    this.record('cancelSubscriptionAtPeriodEnd', id);
    const existing = this.require(id);
    // Still active. Only the intent changes.
    const updated = { ...existing, cancelAtPeriodEnd: true };
    this.subscriptions.set(id, updated);
    return Promise.resolve(updated);
  }

  cancelSubscriptionNow(id: string): Promise<ProviderSubscription> {
    this.record('cancelSubscriptionNow', id);
    const existing = this.require(id);
    const updated = { ...existing, status: SubscriptionStatus.CANCELED };
    this.subscriptions.set(id, updated);
    return Promise.resolve(updated);
  }

  reactivateSubscription(id: string): Promise<ProviderSubscription> {
    this.record('reactivateSubscription', id);
    const existing = this.require(id);
    if (existing.status === SubscriptionStatus.CANCELED) {
      throw new Error('Cannot reactivate a canceled subscription');
    }
    const updated = { ...existing, cancelAtPeriodEnd: false };
    this.subscriptions.set(id, updated);
    return Promise.resolve(updated);
  }

  // --- Payment methods ---

  /**
   * A method the customer has collected but not yet attached, as a checkout or a
   * card element would produce. Tests start here rather than with `attach`,
   * because the service is never given card data — only an identifier.
   */
  collectPaymentMethod(
    overrides: Partial<ProviderPaymentMethod> = {},
  ): ProviderPaymentMethod {
    const method: ProviderPaymentMethod = {
      id: `pm_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      customerId: null,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      isDefault: false,
      ...overrides,
    };
    this.paymentMethods.set(method.id, method);
    return method;
  }

  attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<ProviderPaymentMethod> {
    this.record('attachPaymentMethod', { customerId, paymentMethodId });

    const existing =
      this.paymentMethods.get(paymentMethodId) ??
      this.collectPaymentMethod({ id: paymentMethodId });
    const attached = { ...existing, customerId };
    this.paymentMethods.set(attached.id, attached);

    // Stripe makes the first method a customer holds their default; without
    // that, a first-time subscriber would have nothing to be charged on.
    if (!this.defaultPaymentMethods.has(customerId)) {
      this.defaultPaymentMethods.set(customerId, attached.id);
    }

    return Promise.resolve(this.withDefaultFlag(attached));
  }

  detachPaymentMethod(paymentMethodId: string): Promise<void> {
    this.record('detachPaymentMethod', paymentMethodId);

    const existing = this.paymentMethods.get(paymentMethodId);
    if (!existing) {
      throw new Error(`No provider payment method ${paymentMethodId}`);
    }
    this.paymentMethods.delete(paymentMethodId);

    if (
      existing.customerId &&
      this.defaultPaymentMethods.get(existing.customerId) === paymentMethodId
    ) {
      this.defaultPaymentMethods.delete(existing.customerId);
    }

    return Promise.resolve();
  }

  listPaymentMethods(customerId: string): Promise<ProviderPaymentMethod[]> {
    this.record('listPaymentMethods', customerId);
    return Promise.resolve(
      [...this.paymentMethods.values()]
        .filter((method) => method.customerId === customerId)
        .map((method) => this.withDefaultFlag(method)),
    );
  }

  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<ProviderPaymentMethod> {
    this.record('setDefaultPaymentMethod', { customerId, paymentMethodId });

    const existing = this.paymentMethods.get(paymentMethodId);
    if (!existing || existing.customerId !== customerId) {
      throw new Error(
        `Payment method ${paymentMethodId} is not attached to ${customerId}`,
      );
    }
    // One default per customer, as the provider holds it: setting one replaces
    // whatever was there.
    this.defaultPaymentMethods.set(customerId, paymentMethodId);

    return Promise.resolve(this.withDefaultFlag(existing));
  }

  /** A payment-method delivery, as the provider would send one. */
  deliverPaymentMethodEvent(
    type:
      | 'payment_method.attached'
      | 'payment_method.detached'
      | 'payment_method.updated',
    paymentMethod: ProviderPaymentMethod,
  ): FakeDelivery {
    switch (type) {
      case 'payment_method.attached':
        return this.deliver(type, {
          kind: 'payment-method-attached',
          paymentMethod,
        });
      case 'payment_method.detached':
        return this.deliver(type, {
          kind: 'payment-method-detached',
          paymentMethod,
        });
      case 'payment_method.updated':
        return this.deliver(type, {
          kind: 'payment-method-updated',
          paymentMethod,
        });
    }
  }

  private withDefaultFlag(
    method: ProviderPaymentMethod,
  ): ProviderPaymentMethod {
    return {
      ...method,
      isDefault:
        method.customerId != null &&
        this.defaultPaymentMethods.get(method.customerId) === method.id,
    };
  }

  // --- Checkout ---

  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<ProviderCheckoutSession> {
    this.record('createCheckoutSession', input);

    // The provider replays the original response for a repeated attempt rather
    // than creating a second session. Modelled here because "the same key
    // yields one session" is a property tests need to assert.
    const replayed = input.idempotencyKey
      ? this.sessionsByIdempotencyKey.get(input.idempotencyKey)
      : undefined;
    if (replayed) {
      return Promise.resolve(replayed);
    }

    const session: ProviderCheckoutSession = {
      id: `cs_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      url: `https://checkout.test/${input.priceId}`,
    };
    this.checkoutSessions.set(session.id, session);
    if (input.idempotencyKey) {
      this.sessionsByIdempotencyKey.set(input.idempotencyKey, session);
    }
    // Nothing is subscribed yet: the session is where the payment method is
    // collected, and only completing it creates a subscription.
    this.pendingCheckouts.set(session.id, {
      customerId: input.customerId,
      priceId: input.priceId,
      metadata: input.metadata,
    });
    return Promise.resolve(session);
  }

  /**
   * What the provider reports when a *one-time* checkout is paid.
   *
   * The counterpart to {@link completeCheckout}, which plays the subscription
   * case and produces a subscription. A payment-mode session produces no
   * subscription — only the completion event that fulfils the purchase it was
   * opened for.
   *
   * Note the limit: this hands the endpoint an already-translated event, so the
   * `mode` and `payment_status` filters in the real adapter are not exercised
   * by anything routed through here. Those are covered directly, against
   * `checkoutCompletionOf`.
   */
  payOneTimeCheckout(
    sessionId: string,
    overrides: Partial<ProviderCheckoutCompletion> = {},
  ): FakeDelivery {
    if (!this.checkoutSessions.has(sessionId)) {
      throw new Error(`No checkout session ${sessionId}`);
    }
    this.pendingCheckouts.delete(sessionId);

    const checkout: ProviderCheckoutCompletion = {
      sessionId,
      paymentIntentId: `pi_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      amountTotal: 1000,
      currency: 'usd',
      ...overrides,
    };

    return this.deliver('checkout.session.completed', {
      kind: 'checkout-completed',
      checkout,
    });
  }

  // --- Webhooks ---

  verifyWebhookSignature(payload: Buffer, signature: string): ProviderEvent {
    this.record('verifyWebhookSignature', signature);

    if (signature !== sign(payload)) {
      throw new BillingException(
        ErrorCode.InvalidWebhookSignature,
        'The webhook signature does not verify against the received bytes.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const body = JSON.parse(payload.toString('utf8')) as { id?: string };
    const delivered = body.id ? this.events.get(body.id) : undefined;
    if (!delivered) {
      throw new BillingException(
        ErrorCode.InvalidWebhookSignature,
        'No such event was delivered by this provider.',
        HttpStatus.BAD_REQUEST,
      );
    }

    return { ...delivered, raw: body };
  }

  /**
   * Prepares a delivery the way the provider would send one: the event is
   * remembered here, and the wire payload carries only its identifier. Tampering
   * with the bytes therefore changes the signature and fails verification, which
   * is the property the endpoint's trust rests on.
   */
  deliver(type: string, billing: BillingEvent | null): FakeDelivery {
    const event: ProviderEvent = {
      id: `evt_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      type,
      raw: null,
      billing,
    };
    this.events.set(event.id, event);

    const payload = Buffer.from(
      JSON.stringify({ id: event.id, type: event.type }),
    );
    return { eventId: event.id, payload, signature: sign(payload) };
  }

  /** Redelivers an event already prepared, byte for byte. */
  redeliver(delivery: FakeDelivery): FakeDelivery {
    return { ...delivery };
  }

  /**
   * An invoice for a subscription, as the provider's events would report it.
   *
   * **`paymentIntentId` is null, deliberately.** Stripe does not put it on a
   * delivered invoice: `payments` is an expandable field, and a webhook
   * delivery carries no request with which to expand it. This fake previously
   * minted a `pi_...` here, which made every delivered invoice in every test
   * carry an identifier that no real delivery ever does — and that is precisely
   * why a full integration suite stayed green while the column was null on
   * every subscription payment the service could record.
   *
   * A fake that is more generous than the real provider does not merely fail to
   * catch a bug; it actively certifies the broken behaviour. The intent is
   * available from {@link getInvoice}, as it is from Stripe, and only there.
   *
   * The override is kept so a test can still supply one on purpose.
   */
  invoiceFor(
    providerSubscriptionId: string,
    overrides: Partial<ProviderInvoice> = {},
  ): ProviderInvoice {
    const subscription = this.subscriptions.get(providerSubscriptionId);
    const delivered: ProviderInvoice = {
      id: `in_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      providerSubscriptionId,
      customerId: subscription?.customerId ?? null,
      priceId: subscription?.priceId ?? null,
      amountPaid: 0,
      amountDue: 0,
      currency: 'usd',
      paymentIntentId: null,
      attemptCount: 1,
      nextPaymentAttemptAt: null,
      periodStart: subscription?.currentPeriodStart ?? null,
      periodEnd: subscription?.currentPeriodEnd ?? null,
      billingReason: 'subscription_cycle',
      failureReason: null,
      ...overrides,
    };

    // The retrievable form of the same invoice, which does carry the payment
    // identifier. An explicit override wins — tested with `in` rather than
    // `??`, so that passing `paymentIntentId: null` means "the provider has
    // none either", which is a case worth being able to express. Coalescing
    // would silently turn that into the generated value.
    this.invoices.set(delivered.id, {
      ...delivered,
      paymentIntentId:
        'paymentIntentId' in overrides
          ? (overrides.paymentIntentId ?? null)
          : `pi_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    });

    return delivered;
  }

  // --- Internals ---

  private newSubscription(
    customerId: string,
    priceId: string,
  ): ProviderSubscription {
    const now = this.createdAt ?? new Date();
    return {
      id: `sub_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      customerId,
      priceId,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: now,
      currentPeriodEnd: this.periodEnd(now, priceId),
      cancelAtPeriodEnd: false,
      createdAt: now,
    };
  }

  private periodEnd(from: Date, priceId: string): Date {
    const months = this.priceIntervals.get(priceId) === 'year' ? 12 : 1;
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

  private record(method: string, argument: unknown): void {
    this.calls.push({ method, argument });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  private require(id: string): ProviderSubscription {
    const existing = this.subscriptions.get(id);
    if (!existing) {
      throw new Error(`No provider subscription ${id}`);
    }
    return existing;
  }
}

function sign(payload: Buffer): string {
  return createHmac('sha256', FAKE_SIGNING_SECRET)
    .update(payload)
    .digest('hex');
}
