import type { CheckoutRedirectUrls } from '../common/checkout-urls';
import { SubscriptionStatus } from '../generated/prisma/enums';

/**
 * The seam between billing logic and Stripe (design D1).
 *
 * Subscription, credit, and entitlement logic depends on this interface, never
 * on the Stripe SDK — which is what makes "business logic is testable without
 * network access or credentials" a checkable property rather than an
 * aspiration, and what keeps "no Stripe call inside a database transaction"
 * verifiable by inspection.
 *
 * Nothing here exposes a Stripe SDK type.
 */

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export interface ProviderCustomer {
  id: string;
  email: string | null;
}

export interface ProviderSubscription {
  id: string;
  customerId: string;
  priceId: string;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** The pending period-end cancellation intent, as the provider reports it. */
  cancelAtPeriodEnd: boolean;
  /**
   * When the provider created it. Orphan cleanup needs it to tell a genuine
   * orphan from a subscription whose local row is merely still on its way —
   * a paid checkout writes its row when `invoice.paid` arrives, not before.
   */
  createdAt: Date | null;
}

export interface ProviderCheckoutSession {
  id: string;
  url: string | null;
}

/**
 * A payment method as the provider describes it.
 *
 * Only what a user needs to recognise their own card. There is no field for a
 * card number or a security code, and there is deliberately nowhere to put one:
 * the mirror can hold no card data because this type carries none
 * (`payment-method-mirror` → "No card data stored").
 */
export interface ProviderPaymentMethod {
  id: string;
  /** The customer it is attached to, when the provider reports one. */
  customerId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  /** Whether the provider charges this one by default for the customer. */
  isDefault: boolean;
}

export interface CreateCustomerInput {
  email: string;
  /** Correlates the provider object back to the local user. */
  userId: string;
}

export interface CreateSubscriptionInput {
  customerId: string;
  priceId: string;
  /** Correlation data echoed back on the resulting events. */
  metadata?: Record<string, string>;
}

export interface ChangeSubscriptionPriceInput {
  providerSubscriptionId: string;
  priceId: string;
}

/**
 * One provider invoice, as the events that carry it report it.
 *
 * `attemptCount` and `nextPaymentAttemptAt` are the provider's dunning state,
 * mirrored so the retry policy is observable locally. Nothing local schedules a
 * retry from them (C2).
 */
export interface ProviderInvoice {
  id: string;
  providerSubscriptionId: string | null;
  customerId: string | null;
  priceId: string | null;
  /** Minor units. Zero for a Free subscription's monthly invoice. */
  amountPaid: number;
  amountDue: number;
  currency: string;
  paymentIntentId: string | null;
  attemptCount: number;
  nextPaymentAttemptAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  billingReason: string | null;
  failureReason: string | null;
}

/**
 * What an event means to this service, in this service's vocabulary.
 *
 * The adapter translates; nothing downstream reads a provider payload. That is
 * what keeps handlers testable without the SDK and keeps the set of events the
 * service acts upon *explicit* — an event the adapter does not translate has no
 * `BillingEvent` and therefore no effect, by construction rather than by
 * omission (design D5).
 */
/**
 * A hosted checkout the provider reports as completed and paid.
 *
 * Carries exactly what fulfilling a one-time purchase needs. The session id is
 * the key: an add-on purchase is recorded against it when the checkout starts,
 * so it is what resolves the completion back to the purchase it belongs to.
 *
 * `paymentIntentId` is nullable because the provider does not always produce
 * one. A paid add-on always does, so a null here means something other than the
 * expected flow and the handler says so rather than inventing a value.
 */
export interface ProviderCheckoutCompletion {
  sessionId: string;
  paymentIntentId: string | null;
  /** Minor units, as the provider totalled them. */
  amountTotal: number;
  currency: string;
}

export type BillingEvent =
  | { kind: 'invoice-paid'; invoice: ProviderInvoice }
  | { kind: 'invoice-payment-failed'; invoice: ProviderInvoice }
  | { kind: 'checkout-completed'; checkout: ProviderCheckoutCompletion }
  | { kind: 'subscription-updated'; subscription: ProviderSubscription }
  | { kind: 'subscription-ended'; subscription: ProviderSubscription }
  | { kind: 'payment-method-attached'; paymentMethod: ProviderPaymentMethod }
  | { kind: 'payment-method-detached'; paymentMethod: ProviderPaymentMethod }
  | { kind: 'payment-method-updated'; paymentMethod: ProviderPaymentMethod };

export interface ProviderEvent {
  /** The provider's event id. Processing is idempotent against this. */
  id: string;
  /** The provider's event type, verbatim, for the durable record. */
  type: string;
  /** The delivered body, persisted for diagnosis and never read for logic. */
  raw: unknown;
  /** Null when this event type is one the service does not act upon. */
  billing: BillingEvent | null;
}

export interface CreateCheckoutSessionInput extends CheckoutRedirectUrls {
  customerId: string;
  priceId: string;
  mode: 'subscription' | 'payment';
  metadata?: Record<string, string>;
  /**
   * Identifies this *attempt* at creating a session, so a caller repeating a
   * request it never saw answered gets the original session back rather than a
   * second one.
   *
   * Supplied by the caller and passed through unchanged — deliberately not
   * derived here from the customer and price. A key built from those would say
   * "this user has bought this SKU before", which is a question the database
   * answers; it would also collapse two genuine purchases into one inside the
   * provider's retention window.
   */
  idempotencyKey?: string;
}

export interface BillingProvider {
  // --- Customer ---
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;
  getCustomer(customerId: string): Promise<ProviderCustomer | null>;

  // --- Subscription ---
  createSubscription(
    input: CreateSubscriptionInput,
  ): Promise<ProviderSubscription>;
  getSubscription(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription | null>;

  /**
   * Every subscription the provider holds for a customer, in any status.
   *
   * The seam exposes this for one reason: orphan cleanup is the only job that
   * cannot start from a local query (design D7). Every other job asks "what do
   * our rows say?"; this one asks "what does the provider think exists that we
   * do not?", and a local query can never answer that — the rows it would need
   * are precisely the ones that were never written.
   */
  listCustomerSubscriptions(
    customerId: string,
  ): Promise<ProviderSubscription[]>;

  /**
   * A cycle change: the same provider subscription keeps its identity and
   * swaps its price. Distinct from a plan change, which creates a new
   * subscription entirely (design D3).
   */
  changeSubscriptionPrice(
    input: ChangeSubscriptionPriceInput,
  ): Promise<ProviderSubscription>;

  /**
   * Marks the subscription to end when the current period does. It stays
   * **active** until then, and the user keeps their entitlement.
   *
   * Deliberately a separate method from {@link cancelSubscriptionNow} rather
   * than one call with a flag: the moment they share a path, "provision Free
   * now" is one conditional away from leaking into the period-end mode and
   * cutting a paying user's entitlement short (design D4a, risk R10).
   */
  cancelSubscriptionAtPeriodEnd(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription>;

  /** Ends the subscription at once. Not reversible, and issues no refund. */
  cancelSubscriptionNow(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription>;

  /**
   * Clears the `cancel_at_period_end` intent on an active subscription,
   * restoring normal renewal. Only meaningful for a subscription that had a
   * pending period-end cancellation — there is nothing to reactivate after an
   * immediate cancellation (design D4a).
   */
  reactivateSubscription(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription>;

  // --- Invoices ---

  /**
   * Retrieves an invoice, populated with the fields a *delivery* does not
   * carry.
   *
   * This exists because a provider payload delivered to a webhook is not the
   * same object as one retrieved. Some fields are populated only when the
   * caller asks for them, and a delivery has no request with which to ask — so
   * they are absent from every event, permanently and silently. The payment
   * identifier is the one that matters here: it is how a local payment row is
   * matched to the money that actually moved, and it is not on the event.
   *
   * The asking is the adapter's business. Nothing about expansion, or about
   * which fields need it, appears in this seam or in any caller — they ask for
   * an invoice and get a complete one.
   *
   * Returns `null` when the provider has no such invoice, matching
   * {@link getSubscription} rather than throwing.
   */
  getInvoice(providerInvoiceId: string): Promise<ProviderInvoice | null>;

  // --- Payment methods ---
  //
  // The provider is the authority throughout: it decides what a method's
  // descriptors are and which one is default, and every method here returns
  // what it decided. The local mirror is written from these responses and from
  // `payment_method.*` events, never ahead of them (design D3).

  /** Attaches an already-collected method to the customer. */
  attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<ProviderPaymentMethod>;

  /**
   * Detaches a method from whichever customer holds it. Returns nothing: the
   * method is gone, so there is no state left to project.
   */
  detachPaymentMethod(paymentMethodId: string): Promise<void>;

  listPaymentMethods(customerId: string): Promise<ProviderPaymentMethod[]>;

  /**
   * Makes one method the customer's default for future invoices. This is the
   * operation that decides what gets charged — the local `isDefault` column is
   * a projection of the outcome, not an input to it.
   */
  setDefaultPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<ProviderPaymentMethod>;

  // --- Checkout ---
  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<ProviderCheckoutSession>;

  // --- Webhooks ---

  /**
   * Verifies a delivery against the raw bytes received and translates it.
   *
   * Verification belongs here rather than in the controller because it is a
   * provider SDK operation, and the SDK is confined to the adapter (design D1).
   * Putting it anywhere else would break the confinement rule at the one
   * endpoint whose whole trust model rests on it.
   *
   * Throws a standardised invalid-signature error rather than returning null:
   * an unverifiable delivery is not an event, and no caller should be able to
   * proceed by ignoring a return value.
   */
  verifyWebhookSignature(payload: Buffer, signature: string): ProviderEvent;
}
