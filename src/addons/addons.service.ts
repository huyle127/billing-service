import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import type { CheckoutRedirectUrls } from '../common/checkout-urls';
import type { RelatedEvent } from '../common/related-event';
import { CreditsService } from '../credits/credits.service';
import { CustomersService } from '../customers/customers.service';
import { AddonPurchaseStatus, PaymentStatus } from '../generated/prisma/enums';
import type {
  AddonPurchaseModel,
  CreditGrantModel,
  PaymentModel,
} from '../generated/prisma/models';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type { BillingProvider } from '../provider/billing-provider';
import { SubscriptionLookupService } from '../subscriptions/subscription-lookup.service';

export interface InitiateAddonPurchaseInput extends CheckoutRedirectUrls {
  userId: string;
  productId: string;
  /** The catalogued add-on SKU, e.g. `credits-100`. */
  addonPackageKey: string;
  /**
   * Identifies this attempt, so a caller repeating a request it never saw
   * answered is given the original session rather than a second one. Supplied
   * by the caller: only they can say whether this is a retry or a new purchase.
   */
  idempotencyKey?: string;
}

export interface AddonCheckout {
  addonPurchaseId: string;
  checkoutSessionId: string;
  url: string | null;
  /** What the purchase will grant, read from the SKU. */
  creditAmount: number;
}

export interface FulfilAddonPurchaseInput {
  providerCheckoutSessionId: string;
  providerPaymentIntentId: string;
  amount: number;
  currency: string;
  relatedEvent?: RelatedEvent;
}

export interface AddonFulfilment {
  purchase: AddonPurchaseModel;
  payment: PaymentModel;
  grant: CreditGrantModel;
  /** False when this payment had already been fulfilled. */
  created: boolean;
}

/**
 * One-time credit add-ons.
 *
 * Two rules define the flow, and they are deliberately at opposite ends of it:
 * eligibility is decided *before* the provider is touched, and credit is granted
 * only *after* the provider confirms payment. Between those two points nothing
 * about entitlement changes.
 *
 * An add-on purchase never creates, modifies, or terminates a Subscription. It
 * is a payment against a SKU, and the only thing it produces is a grant.
 */
@Injectable()
export class AddonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly customers: CustomersService,
    private readonly credits: CreditsService,
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionLookupService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /**
   * Starts a purchase for a user who holds a live paid subscription.
   *
   * The eligibility check is the first thing that happens, before any provider
   * call: a Free user must not end up with a checkout session or a payment intent
   * to abandon, and — paired with the add-on freeze rule — nobody may buy credit
   * that is unspendable the moment it arrives.
   *
   * Writes no grant and no payment. The purchase row records the correlation
   * reference and nothing else.
   */
  async initiatePurchase(
    input: InitiateAddonPurchaseInput,
  ): Promise<AddonCheckout> {
    await this.subscriptions.requireLivePaid(
      input.userId,
      input.productId,
      'Purchasing a credit add-on',
    );

    const addonPackage = await this.catalog.getAddonPackageByKey(
      input.productId,
      input.addonPackageKey,
    );

    const customerId = await this.customers.requireProviderCustomer(
      input.userId,
    );

    // `payment`, not `subscription`: an add-on is a one-time charge and must not
    // recur or produce a provider subscription.
    const session = await this.provider.createCheckoutSession({
      customerId,
      priceId: addonPackage.stripePriceId,
      mode: 'payment',
      idempotencyKey: input.idempotencyKey,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: {
        userId: input.userId,
        productId: input.productId,
        addonPackageId: addonPackage.id,
      },
    });

    // Keyed on the session, and an upsert rather than a create, because the
    // provider replays a session for a repeated attempt: an idempotent call at
    // the provider needs an idempotent write here to match, or the second
    // attempt gets the first session back and then collides with the unique
    // index on it. `update: {}` because a replayed attempt describes the same
    // purchase — there is nothing to change, only an existing row to return.
    const purchase = await this.prisma.addonPurchase.upsert({
      where: { providerCheckoutSessionId: session.id },
      create: {
        userId: input.userId,
        productId: input.productId,
        addonPackageId: addonPackage.id,
        status: AddonPurchaseStatus.PENDING,
        providerCheckoutSessionId: session.id,
      },
      update: {},
    });

    return {
      addonPurchaseId: purchase.id,
      checkoutSessionId: session.id,
      url: session.url,
      creditAmount: addonPackage.creditAmount,
    };
  }

  /**
   * Completes a purchase the provider has confirmed paid: the payment record,
   * the grant, its ledger entry, and the purchase's completion, all in one
   * transaction.
   *
   * Idempotent by construction rather than by an early return — the payment is
   * keyed by its payment intent and the grant by its purchase, so a redelivered
   * event re-reads both and writes neither.
   */
  async fulfilPurchase(
    input: FulfilAddonPurchaseInput,
  ): Promise<AddonFulfilment> {
    const purchase = await this.prisma.addonPurchase.findUnique({
      where: { providerCheckoutSessionId: input.providerCheckoutSessionId },
      include: { addonPackage: true },
    });
    if (!purchase) {
      throw new BillingException(
        ErrorCode.NotFound,
        `No add-on purchase was initiated for checkout session ` +
          `${input.providerCheckoutSessionId}.`,
        HttpStatus.NOT_FOUND,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const { payment, created } = await this.payments.recordAddonPayment(
        {
          userId: purchase.userId,
          addonPurchaseId: purchase.id,
          amount: input.amount,
          currency: input.currency,
          status: PaymentStatus.SUCCEEDED,
          providerPaymentIntentId: input.providerPaymentIntentId,
        },
        tx,
      );

      const grant = await this.credits.grantAddonCredits(
        {
          userId: purchase.userId,
          productId: purchase.productId,
          addonPurchaseId: purchase.id,
          // From the catalogued SKU, never from the amount paid.
          amount: purchase.addonPackage.creditAmount,
          relatedEvent: input.relatedEvent,
        },
        tx,
      );

      const completed = await tx.addonPurchase.update({
        where: { id: purchase.id },
        data: { status: AddonPurchaseStatus.COMPLETED },
      });

      return { purchase: completed, payment, grant, created };
    });
  }

  /** A user's add-on purchases for a Product, newest first. */
  listPurchases(
    userId: string,
    productId: string,
  ): Promise<AddonPurchaseModel[]> {
    return this.prisma.addonPurchase.findMany({
      where: { userId, productId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
