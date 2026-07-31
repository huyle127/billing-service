import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { toSubscriptionStatus } from '../subscriptions/subscription-status';
import {
  BillingEvent,
  BillingProvider,
  ChangeSubscriptionPriceInput,
  CreateCheckoutSessionInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  ProviderCheckoutCompletion,
  ProviderCheckoutSession,
  ProviderCustomer,
  ProviderEvent,
  ProviderInvoice,
  ProviderPaymentMethod,
  ProviderSubscription,
} from './billing-provider';
import { mapStripeError } from './stripe-error';

/**
 * The provider event types this service acts upon. Anything else is translated
 * to a null `billing`, which is what makes "handled events are explicit" a
 * property of the translation rather than of a scattered set of `if`s.
 */
const HANDLED_EVENT_TYPES = {
  invoicePaid: 'invoice.paid',
  invoicePaymentFailed: 'invoice.payment_failed',
  checkoutSessionCompleted: 'checkout.session.completed',
  subscriptionUpdated: 'customer.subscription.updated',
  subscriptionDeleted: 'customer.subscription.deleted',
  paymentMethodAttached: 'payment_method.attached',
  paymentMethodDetached: 'payment_method.detached',
  paymentMethodUpdated: 'payment_method.updated',
} as const;

/**
 * Translates a completed checkout, or reports that it is not one to act upon.
 *
 * Two filters, both here rather than in a handler, so that a session this
 * service must not fulfil has no `BillingEvent` at all — unactionable by
 * construction rather than by a handler remembering to check:
 *
 * - **`mode`.** A subscription checkout is answered by `invoice.paid`, which is
 *   what creates the paid row and allocates its credit period. Routing one here
 *   too would mean two handlers for one payment.
 * - **`payment_status`.** A session can complete without being paid when an
 *   asynchronous payment method is used; the money settles later, under a
 *   different event. Granting credit for an unpaid session is precisely what
 *   `addon-purchase` → "granted only after successful payment" forbids.
 *
 * Exported so both filters can be tested directly. The fake provider used by
 * integration tests is handed an already-translated event, so it cannot
 * exercise this — and a test that appeared to cover these filters while going
 * through the fake would be testing nothing.
 */
export function checkoutCompletionOf(
  session: Stripe.Checkout.Session,
): ProviderCheckoutCompletion | null {
  if (session.mode !== 'payment' || session.payment_status !== 'paid') {
    return null;
  }

  return {
    sessionId: session.id,
    paymentIntentId: idOf(session.payment_intent),
    amountTotal: session.amount_total ?? 0,
    currency: session.currency ?? '',
  };
}

/**
 * One provider invoice, in this service's vocabulary.
 *
 * Exported, and a module-level function rather than a method, for the same
 * reason as {@link checkoutCompletionOf}: it reads deep, version-sensitive
 * payload paths, and the only honest way to check those is against a payload
 * Stripe actually produced. It depends on nothing but its argument, so a test
 * can hand it a captured delivery directly.
 *
 * **`paymentIntentId` is null on a delivered invoice, and that is not a bug
 * here.** `payments` is an expandable field: Stripe omits it unless the request
 * asks, and a webhook delivery has no request to ask with. The value is
 * resolved separately through {@link BillingProvider.getInvoice}, which does
 * ask. Reading it here anyway is deliberate — a payload that *does* carry one
 * should be used rather than refetched.
 */
export function toProviderInvoice(invoice: Stripe.Invoice): ProviderInvoice {
  // A subscription invoice carries its subscription on the line item, and the
  // first non-proration line is the one describing the period being paid — a
  // proration line would report a partial period and mislead credit
  // allocation about which period it covers.
  const line =
    invoice.lines.data.find((candidate) => !isProration(candidate)) ??
    invoice.lines.data[0];
  const parent = line?.parent?.subscription_item_details;

  return {
    id: invoice.id ?? '',
    providerSubscriptionId: idOf(parent?.subscription),
    customerId: idOf(invoice.customer),
    priceId: idOf(line?.pricing?.price_details?.price),
    amountPaid: invoice.amount_paid,
    amountDue: invoice.amount_due,
    currency: invoice.currency,
    paymentIntentId: idOf(invoice.payments?.data[0]?.payment?.payment_intent),
    attemptCount: invoice.attempt_count,
    nextPaymentAttemptAt: toDate(invoice.next_payment_attempt),
    periodStart: toDate(line?.period?.start),
    periodEnd: toDate(line?.period?.end),
    billingReason: invoice.billing_reason ?? null,
    failureReason: invoice.last_finalization_error?.message ?? null,
  };
}

/** One provider subscription, in this service's vocabulary. Exported for the
 * same reason as {@link toProviderInvoice}. */
export function toProviderSubscription(
  subscription: Stripe.Subscription,
): ProviderSubscription {
  const item = subscription.items.data[0];
  return {
    id: subscription.id,
    customerId:
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id,
    priceId: item?.price.id ?? '',
    status: toSubscriptionStatus(subscription.status),
    currentPeriodStart: toDate(item?.current_period_start),
    currentPeriodEnd: toDate(item?.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    createdAt: toDate(subscription.created),
  };
}

/**
 * The one file permitted to import the Stripe SDK. Everything it returns is a
 * plain provider DTO, so no Stripe type escapes this boundary (design D1).
 */
@Injectable()
export class StripeBillingProvider implements BillingProvider {
  private readonly logger = new Logger(StripeBillingProvider.name);
  private readonly stripe: Stripe;

  constructor(private readonly config: ConfigService) {
    this.stripe = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
      // Pinned, not inherited from the account. The field paths this file
      // reads — `line.parent.subscription_item_details.subscription`,
      // `invoice.payments.data[0].payment.payment_intent` — are version
      // specific, and an account-level version change would make them resolve
      // to `undefined`. `invoice.paid` would then find no subscription id,
      // return `'ignored'`, and credit allocation would stop with no error
      // raised anywhere.
      //
      // This literal is the `ApiVersion` the installed `stripe` package
      // targets, so the SDK's types and the wire format describe the same
      // thing. **Upgrading the package and changing this value are one
      // change**: a major bump that moves `ApiVersion` and leaves this behind
      // reintroduces exactly the mismatch the pin exists to prevent.
      //
      // Pinned 2026-07-29 against `stripe@22.3.2`, whose exported `ApiVersion`
      // is this exact string — checked, not assumed. Both translators were then
      // verified against genuine payloads from a real subscription; the
      // fixtures are committed under `test/fixtures/stripe` and asserted by
      // `real-payload.spec.ts`, so the check is standing rather than one-off.
      //
      // Two findings from that verification are worth knowing here. The
      // account's default version is `2026-05-27.dahlia`, one behind this pin,
      // and the two are identical for every path this file reads. And
      // `invoice.payments` turned out to be absent from deliveries entirely —
      // see the note on `toProviderInvoice`.
      apiVersion: '2026-06-24.dahlia',
      // Safe because every write that may be retried either carries a
      // caller-supplied idempotency key or is naturally convergent; the SDK
      // manages its own key across these attempts.
      //
      // Verified in `stripe@22.3.2` rather than taken on trust
      // (`cjs/RequestSender.js`): `_defaultIdempotencyKey` generates a
      // `stripe-node-retry-<uuid>` key for a v1 POST whenever this option is
      // above zero, `_makeHeaders` runs once per request, and each retry is
      // handed that same headers object — so all attempts at one call carry one
      // key. A caller-supplied `Idempotency-Key` overrides it, since user
      // headers are normalised over the defaults rather than appended.
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }

  // --- Customer ---

  async createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer> {
    return this.call(async () => {
      const customer = await this.stripe.customers.create({
        email: input.email,
        metadata: { userId: input.userId },
      });
      return { id: customer.id, email: customer.email };
    });
  }

  async getCustomer(customerId: string): Promise<ProviderCustomer | null> {
    return this.call(async () => {
      const customer = await this.stripe.customers.retrieve(customerId);
      if (customer.deleted) {
        return null;
      }
      return { id: customer.id, email: customer.email };
    });
  }

  // --- Subscription ---

  async createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<ProviderSubscription> {
    return this.call(async () => {
      const subscription = await this.stripe.subscriptions.create({
        customer: input.customerId,
        items: [{ price: input.priceId }],
        metadata: input.metadata,
      });
      return toProviderSubscription(subscription);
    });
  }

  async getSubscription(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription | null> {
    try {
      const subscription = await this.stripe.subscriptions.retrieve(
        providerSubscriptionId,
      );
      return toProviderSubscription(subscription);
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === 'resource_missing'
      ) {
        return null;
      }
      throw mapStripeError(error);
    }
  }

  async listCustomerSubscriptions(
    customerId: string,
  ): Promise<ProviderSubscription[]> {
    return this.call(async () => {
      // `status: 'all'` because the question orphan cleanup asks includes
      // subscriptions Stripe no longer considers active — a cancelled one is
      // already reconciled, and seeing it is how the job knows to leave it be
      // rather than issuing a second cancellation.
      const page = await this.stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 100,
      });
      return page.data.map((subscription) =>
        toProviderSubscription(subscription),
      );
    });
  }

  async changeSubscriptionPrice(
    input: ChangeSubscriptionPriceInput,
  ): Promise<ProviderSubscription> {
    return this.call(async () => {
      const current = await this.stripe.subscriptions.retrieve(
        input.providerSubscriptionId,
      );
      const item = current.items.data[0];

      // Updating the item's price keeps the same provider subscription, and
      // therefore the same local row and the same providerSubscriptionId.
      const updated = await this.stripe.subscriptions.update(
        input.providerSubscriptionId,
        { items: [{ id: item.id, price: input.priceId }] },
      );
      return toProviderSubscription(updated);
    });
  }

  async cancelSubscriptionAtPeriodEnd(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription> {
    return this.call(async () => {
      // The subscription stays active until the period ends; this only records
      // the intent at the provider.
      const updated = await this.stripe.subscriptions.update(
        providerSubscriptionId,
        { cancel_at_period_end: true },
      );
      return toProviderSubscription(updated);
    });
  }

  async cancelSubscriptionNow(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription> {
    return this.call(async () => {
      // No `prorate` or refund parameters: money already collected stays
      // collected, and only entitlement changes.
      const cancelled = await this.stripe.subscriptions.cancel(
        providerSubscriptionId,
      );
      return toProviderSubscription(cancelled);
    });
  }

  // --- Invoices ---

  async getInvoice(providerInvoiceId: string): Promise<ProviderInvoice | null> {
    try {
      // `payments` is expandable, and this is the only place it can be asked
      // for: a webhook delivery carries no request, so the payment identifier
      // is absent from every `invoice.paid` event Stripe sends. Verified
      // against real payloads — see `real-payload.spec.ts`.
      const invoice = await this.stripe.invoices.retrieve(providerInvoiceId, {
        expand: ['payments'],
      });
      return toProviderInvoice(invoice);
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.code === 'resource_missing'
      ) {
        return null;
      }
      throw mapStripeError(error);
    }
  }

  // --- Payment methods ---

  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<ProviderPaymentMethod> {
    return this.call(async () => {
      const attached = await this.stripe.paymentMethods.attach(
        paymentMethodId,
        { customer: customerId },
      );
      return this.toProviderPaymentMethod(
        attached,
        await this.defaultPaymentMethodId(customerId),
      );
    });
  }

  async detachPaymentMethod(paymentMethodId: string): Promise<void> {
    await this.call(() => this.stripe.paymentMethods.detach(paymentMethodId));
  }

  async listPaymentMethods(
    customerId: string,
  ): Promise<ProviderPaymentMethod[]> {
    return this.call(async () => {
      const [page, defaultId] = await Promise.all([
        this.stripe.paymentMethods.list({ customer: customerId, limit: 100 }),
        this.defaultPaymentMethodId(customerId),
      ]);
      return page.data.map((method) =>
        this.toProviderPaymentMethod(method, defaultId),
      );
    });
  }

  async setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<ProviderPaymentMethod> {
    return this.call(async () => {
      // The customer's invoice settings are where Stripe records which method
      // recurring charges use, so this is the write that decides what is
      // charged. Nothing local does.
      await this.stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
      const method = await this.stripe.paymentMethods.retrieve(paymentMethodId);
      return this.toProviderPaymentMethod(method, paymentMethodId);
    });
  }

  /** Which method the provider currently charges for this customer, if any. */
  private async defaultPaymentMethodId(
    customerId: string,
  ): Promise<string | null> {
    const customer = await this.stripe.customers.retrieve(customerId);
    if (customer.deleted) {
      return null;
    }
    return idOf(customer.invoice_settings?.default_payment_method);
  }

  private toProviderPaymentMethod(
    method: Stripe.PaymentMethod,
    defaultPaymentMethodId: string | null,
  ): ProviderPaymentMethod {
    return {
      id: method.id,
      customerId: idOf(method.customer),
      // `card` is absent for method types that are not cards; the descriptors
      // are simply unknown then, and the mirror stores nulls rather than
      // inventing values.
      brand: method.card?.brand ?? null,
      last4: method.card?.last4 ?? null,
      expMonth: method.card?.exp_month ?? null,
      expYear: method.card?.exp_year ?? null,
      isDefault: method.id === defaultPaymentMethodId,
    };
  }

  // --- Checkout ---

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<ProviderCheckoutSession> {
    return this.call(async () => {
      const session = await this.stripe.checkout.sessions.create(
        {
          customer: input.customerId,
          mode: input.mode,
          line_items: [{ price: input.priceId, quantity: 1 }],
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          metadata: input.metadata,
        },
        // Passed through from the caller, never derived here. Absent means the
        // caller did not claim this is a repeat, so the provider treats it as a
        // new request — which is the correct reading of an unqualified retry.
        input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : undefined,
      );
      return { id: session.id, url: session.url };
    });
  }

  async reactivateSubscription(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription> {
    return this.call(async () => {
      const subscription = await this.stripe.subscriptions.update(
        providerSubscriptionId,
        { cancel_at_period_end: false },
      );
      return toProviderSubscription(subscription);
    });
  }

  // --- Webhooks ---

  verifyWebhookSignature(payload: Buffer, signature: string): ProviderEvent {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      // A delivery that does not verify is not an event. It is refused here so
      // that nothing downstream can be reached by an unsigned payload.
      throw new BillingException(
        ErrorCode.InvalidWebhookSignature,
        'The webhook signature does not verify against the received bytes.',
        HttpStatus.BAD_REQUEST,
        { reason: error instanceof Error ? error.message : undefined },
      );
    }

    return {
      id: event.id,
      type: event.type,
      raw: event,
      billing: this.toBillingEvent(event),
    };
  }

  /**
   * Translates a Stripe event into this service's vocabulary, or to `null` when
   * the service does not act upon it. This is the only place a Stripe payload
   * shape is read.
   */
  private toBillingEvent(event: Stripe.Event): BillingEvent | null {
    switch (event.type) {
      case HANDLED_EVENT_TYPES.invoicePaid:
        return {
          kind: 'invoice-paid',
          invoice: toProviderInvoice(event.data.object),
        };
      case HANDLED_EVENT_TYPES.invoicePaymentFailed:
        return {
          kind: 'invoice-payment-failed',
          invoice: toProviderInvoice(event.data.object),
        };
      case HANDLED_EVENT_TYPES.checkoutSessionCompleted: {
        const checkout = checkoutCompletionOf(event.data.object);
        return checkout ? { kind: 'checkout-completed', checkout } : null;
      }
      case HANDLED_EVENT_TYPES.subscriptionUpdated:
        return {
          kind: 'subscription-updated',
          subscription: toProviderSubscription(event.data.object),
        };
      case HANDLED_EVENT_TYPES.subscriptionDeleted:
        return {
          kind: 'subscription-ended',
          subscription: toProviderSubscription(event.data.object),
        };
      case HANDLED_EVENT_TYPES.paymentMethodAttached:
        return {
          kind: 'payment-method-attached',
          paymentMethod: this.toEventPaymentMethod(event.data.object),
        };
      case HANDLED_EVENT_TYPES.paymentMethodDetached:
        return {
          kind: 'payment-method-detached',
          paymentMethod: this.toEventPaymentMethod(event.data.object),
        };
      case HANDLED_EVENT_TYPES.paymentMethodUpdated:
        return {
          kind: 'payment-method-updated',
          paymentMethod: this.toEventPaymentMethod(event.data.object),
        };
      default:
        return null;
    }
  }

  /**
   * A payment method carried by an event.
   *
   * `isDefault` is reported `false` because a single payment-method event cannot
   * say which method the customer's invoice settings point at, and verification
   * is synchronous so nothing may be fetched here. The handler therefore refreshes
   * the customer's methods from the provider rather than projecting this flag —
   * see `PaymentMethodsService.refreshFromProvider`.
   */
  private toEventPaymentMethod(
    method: Stripe.PaymentMethod,
  ): ProviderPaymentMethod {
    return this.toProviderPaymentMethod(method, null);
  }

  // --- Internals ---

  private get webhookSecret(): string {
    return this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.warn(
        `Stripe call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw mapStripeError(error);
    }
  }
}

function toDate(epochSeconds: number | null | undefined): Date | null {
  return typeof epochSeconds === 'number'
    ? new Date(epochSeconds * 1000)
    : null;
}

function isProration(line: Stripe.InvoiceLineItem): boolean {
  return (
    line.parent?.subscription_item_details?.proration ??
    line.parent?.invoice_item_details?.proration ??
    false
  );
}

/** Stripe expands references inconsistently; only the identifier is wanted. */
function idOf(
  reference: string | { id?: string } | null | undefined,
): string | null {
  if (!reference) {
    return null;
  }
  return typeof reference === 'string' ? reference : (reference.id ?? null);
}
