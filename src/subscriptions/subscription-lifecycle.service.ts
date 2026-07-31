import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { creditPolicyOf } from '../catalog/credit-policy';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { isUniqueViolation } from '../common/prisma-errors';
import { creditPeriodFrom } from '../credits/credit-period';
import type { CheckoutRedirectUrls } from '../common/checkout-urls';
import type { RelatedEvent } from '../common/related-event';
import { CreditsService } from '../credits/credits.service';
import { CustomersService } from '../customers/customers.service';
import { BillingInterval } from '../generated/prisma/enums';
import type { SubscriptionModel } from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type {
  BillingProvider,
  ProviderSubscription,
} from '../provider/billing-provider';
import { ProvisioningService } from './provisioning.service';
import { SubscriptionLookupService } from './subscription-lookup.service';
import { SubscriptionRepository } from './subscription.repository';
import type { SubscriptionWithCatalog } from './subscription-lookup.service';
import { isLive, isTerminal } from './subscription-status';

export interface CreateProCheckoutInput extends CheckoutRedirectUrls {
  userId: string;
  productId: string;
  billingInterval: BillingInterval;
  /**
   * Identifies this attempt, so a caller repeating a request it never saw
   * answered is given the original session rather than a second one. Supplied
   * by the caller: only they can distinguish a retry from a fresh purchase.
   */
  idempotencyKey?: string;
}

export interface ProCheckout {
  checkoutSessionId: string;
  url: string | null;
}

export interface TransitionFreeToProInput {
  userId: string;
  productId: string;
  /** The provider subscription whose first invoice has been paid. */
  providerSubscriptionId: string;
  relatedEvent?: RelatedEvent;
}

export interface TransitionProToFreeInput {
  subscriptionId: string;
  /**
   * A provider report already in hand — the confirmed result of a cancellation
   * call, or the state a webhook delivered. Omitted, the provider is asked
   * directly. Either way the transition acts on what the provider says, never on
   * what a caller intends.
   */
  providerState?: ProviderSubscription;
  relatedEvent?: RelatedEvent;
}

export interface ProToFreeResult {
  freeSubscription: SubscriptionModel;
  /** True when another path had already completed this transition. */
  alreadyApplied: boolean;
}

/**
 * The subscription lifecycle.
 *
 * Two rules shape every method here, and most of the comments below exist to
 * keep them visible:
 *
 * 1. **Stripe owns status** (design D0). Nothing in this service decides that a
 *    subscription has ended; it synchronises what the provider reports. The one
 *    place a status is written ahead of the provider is the Free row superseded
 *    by an upgrade, and that is called out where it happens.
 * 2. **The two cancellation modes are separate behaviours** (design D4a). They
 *    share the Pro → Free transition and nothing else — no shared entry point,
 *    no mode flag. Collapsing them is what would let "provision Free now" leak
 *    into the period-end path and cut a paying user's entitlement short.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly customers: CustomersService,
    private readonly credits: CreditsService,
    private readonly provisioning: ProvisioningService,
    private readonly subscriptionLookup: SubscriptionLookupService,
    private readonly subscriptions: SubscriptionRepository,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  // -------------------------------------------------------------------------
  // Purchase
  // -------------------------------------------------------------------------

  /**
   * Starts a Pro purchase. Creating the session is not a billing event: no
   * Subscription row and no grant are written, because entitlement comes from
   * provider-confirmed payment and from nothing else. The checkout session is
   * also where the payment method is collected, so a user without one can reach
   * it — they simply cannot complete it.
   */
  async createProCheckout(input: CreateProCheckoutInput): Promise<ProCheckout> {
    const live = await this.subscriptionLookup.findLive(
      input.userId,
      input.productId,
    );
    if (live?.plan.isPaid) {
      // Refused before any provider call, so no second Stripe subscription and
      // no abandoned session exist to be reconciled later.
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        'A live paid subscription for this product already exists. Change the ' +
          'cycle on it, or reactivate it if its renewal was cancelled, rather ' +
          'than purchasing a second plan.',
        HttpStatus.CONFLICT,
        {
          subscriptionId: live.id,
          availableOperations: ['change-cycle', 'reactivate'],
        },
      );
    }

    const paidPlan = await this.catalog.resolveSolePlan(input.productId, true);
    const pricingOption = await this.catalog.resolvePricingOption(
      paidPlan.id,
      input.billingInterval,
    );
    const customerId = await this.customers.requireProviderCustomer(
      input.userId,
    );

    const session = await this.provider.createCheckoutSession({
      customerId,
      priceId: pricingOption.stripePriceId,
      mode: 'subscription',
      idempotencyKey: input.idempotencyKey,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: {
        userId: input.userId,
        productId: input.productId,
        pricingOptionId: pricingOption.id,
      },
    });

    // The only thing recorded: enough to attribute the later event to the user,
    // Product, and SKU that started this.
    await this.subscriptions.recordCheckout({
      userId: input.userId,
      productId: input.productId,
      pricingOptionId: pricingOption.id,
      providerCheckoutSessionId: session.id,
    });

    return { checkoutSessionId: session.id, url: session.url };
  }

  // -------------------------------------------------------------------------
  // Plan changes
  // -------------------------------------------------------------------------

  /**
   * Free → Pro, driven by the paid first invoice for a newly created provider
   * subscription.
   *
   * One transaction covers the Free row leaving the live set, the Pro row
   * entering it, and the credit period's grant, because a state with only some
   * of those is a state in which a user has paid and cannot spend, or holds two
   * live subscriptions. The superseded Free subscription is cancelled at the
   * provider *after* the commit — an orphan there is recoverable, a half-applied
   * money path is not (design D5).
   */
  async transitionFreeToPro(
    input: TransitionFreeToProInput,
  ): Promise<SubscriptionModel> {
    const atProvider = await this.requireProviderSubscription(
      input.providerSubscriptionId,
    );
    if (!isLive(atProvider.status)) {
      // An abandoned or expired checkout reports something other than in force.
      // Refusing here is what keeps "rows are created by payment" true.
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        `The provider reports subscription ${atProvider.id} as ` +
          `${atProvider.status}, not in force, so no paid subscription is created.`,
        HttpStatus.CONFLICT,
      );
    }

    const existing = await this.subscriptions.findByProviderId(atProvider.id);
    if (existing) {
      // A redelivered invoice. The row and its grant committed together, so
      // there is nothing left to do and nothing to repeat.
      return existing;
    }

    const pricingOption = await this.prisma.pricingOption.findUnique({
      where: { stripePriceId: atProvider.priceId },
      include: { plan: true },
    });
    if (
      !pricingOption ||
      !pricingOption.plan.isPaid ||
      pricingOption.plan.productId !== input.productId
    ) {
      throw new BillingException(
        ErrorCode.InvalidPlanOrCycle,
        `No paid plan for this product is catalogued against provider price ` +
          `${atProvider.priceId}.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const departing = await this.subscriptionLookup.findLive(
      input.userId,
      input.productId,
    );
    if (departing?.plan.isPaid) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        'This user already holds a live paid subscription for the product.',
        HttpStatus.CONFLICT,
        { subscriptionId: departing.id },
      );
    }

    const policy = creditPolicyOf(pricingOption.plan);
    // From the plan's credit policy, not from the billing period: an annual
    // subscription's first credit period is one month, not one year.
    const creditPeriod = creditPeriodFrom(
      atProvider.currentPeriodStart ?? new Date(),
      policy,
    );

    const pro = await this.prisma.$transaction(async (tx) => {
      if (departing) {
        // The one status this service writes ahead of the provider. The
        // one-live-row index forces the Free row out of the live set in the same
        // transaction that puts the Pro row in it, and the cancellation that
        // makes this true at Stripe is issued as soon as the commit lands.
        await this.subscriptions.markCanceled(tx, departing.id);
        // Its unspent credit goes with it: subscription credit lasts exactly as
        // long as the subscription that conferred it (design D4b).
        await this.credits.expireSubscriptionGrants(
          departing.id,
          input.relatedEvent,
          tx,
        );
      }

      const created = await this.subscriptions.insert(tx, {
        userId: input.userId,
        productId: input.productId,
        planId: pricingOption.planId,
        pricingOptionId: pricingOption.id,
        providerSubscriptionId: atProvider.id,
        status: atProvider.status,
        cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
        currentPeriodStart: atProvider.currentPeriodStart,
        currentPeriodEnd: atProvider.currentPeriodEnd,
        nextCreditResetAt: creditPeriod.end,
      });

      await this.credits.allocateSubscriptionCredits(
        {
          userId: input.userId,
          productId: input.productId,
          subscriptionId: created.id,
          creditPeriodStart: creditPeriod.start,
          creditPeriodEnd: creditPeriod.end,
          amount: policy.creditsPerPeriod,
          relatedEvent: input.relatedEvent,
        },
        tx,
      );

      return created;
    });

    if (departing) {
      await this.cancelSupersededSubscription(departing);
    }

    return pro;
  }

  /**
   * The one Pro → Free transition, shared by all three ways Pro entitlement can
   * end: a period-end cancellation taking effect, an immediate cancellation, and
   * exhausted dunning. They differ in what changed the provider's state and
   * when — never in what happens here.
   *
   * Entered on provider-confirmed state only. The check below is what makes that
   * structural rather than a convention each caller has to honour.
   *
   * Writes no Free grant. The Free plan's credits arrive with the new
   * subscription's own `$0 invoice.paid` through the standing allocation
   * routine, which is both what AGENTS.md requires of subscription credit and
   * what makes Free's first period after a downgrade identical to Free's first
   * period after registration (design D4b).
   *
   * A departing *Free* subscription is served by this same routine rather than
   * by a second one. Stripe deleting a Free subscription that nothing has
   * replaced leaves the user with no entitlement at all, and the fix is exactly
   * what this does — which is also why it stays the only path that provisions
   * Free outside registration and the repair job.
   */
  async transitionProToFree(
    input: TransitionProToFreeInput,
  ): Promise<ProToFreeResult> {
    const pro = await this.requireSubscription(input.subscriptionId);

    const atProvider =
      input.providerState ??
      (await this.requireProviderSubscription(pro.providerSubscriptionId));
    if (isLive(atProvider.status)) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        `The provider still reports subscription ${atProvider.id} as in force ` +
          `(${atProvider.status}). The transition to Free follows the provider, ` +
          `so a pending intent or a request is not enough to enter it.`,
        HttpStatus.CONFLICT,
      );
    }

    const live = await this.subscriptionLookup.findLive(
      pro.userId,
      pro.productId,
    );
    if (live && live.id !== pro.id) {
      // The webhook and reconciliation can both arrive; whichever is second
      // finds the work done. Checked before the provider call so a redelivery
      // does not orphan a Free subscription at Stripe.
      return { freeSubscription: live, alreadyApplied: true };
    }

    const prepared = await this.provisioning.prepareFreeSubscription(
      pro.userId,
      pro.productId,
    );

    try {
      const free = await this.prisma.$transaction(async (tx) => {
        await this.subscriptions.update(
          pro.id,
          {
            // Synchronised from the provider, which is the only reason this row
            // leaves the live set.
            status: atProvider.status,
            cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
            currentPeriodEnd:
              atProvider.currentPeriodEnd ?? pro.currentPeriodEnd,
          },
          tx,
        );

        // Expiry for what the departing subscription granted; add-on grants are
        // deliberately untouched, so they are frozen by the derived rule rather
        // than destroyed. Freeze and expiry are different mechanisms.
        await this.credits.expireSubscriptionGrants(
          pro.id,
          input.relatedEvent,
          tx,
        );

        return this.provisioning.insertFreeSubscriptionRow(tx, prepared);
      });

      return { freeSubscription: free, alreadyApplied: false };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // Another instance completed the transition between the check above and
      // this insert. The live index decided; this call yields to it and leaves
      // nothing behind at the provider.
      await this.provisioning.discardPreparedSubscription(prepared);
      const winner = await this.subscriptionLookup.findLive(
        pro.userId,
        pro.productId,
      );
      if (!winner) {
        throw error;
      }
      return { freeSubscription: winner, alreadyApplied: true };
    }
  }

  /**
   * Monthly ↔ Annual: a price change on the same provider subscription and the
   * same local row (design D3). Grants nothing and moves no credit-period
   * boundary — the billing period changes, the credit period does not, which is
   * exactly the divergence the scheduled reset exists to serve.
   */
  async changeCycle(
    subscriptionId: string,
    billingInterval: BillingInterval,
  ): Promise<SubscriptionModel> {
    const subscription = await this.requireLivePaidSubscription(subscriptionId);
    const target = await this.catalog.resolvePricingOption(
      subscription.planId,
      billingInterval,
    );

    const atProvider = await this.provider.changeSubscriptionPrice({
      providerSubscriptionId: subscription.providerSubscriptionId,
      priceId: target.stripePriceId,
    });

    return this.subscriptions.update(subscription.id, {
      pricingOptionId: target.id,
      status: atProvider.status,
      cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
      currentPeriodStart: atProvider.currentPeriodStart,
      currentPeriodEnd: atProvider.currentPeriodEnd,
      // `nextCreditResetAt` is deliberately absent: the next reset falls due
      // when it would have anyway.
    });
  }

  // -------------------------------------------------------------------------
  // Cancellation — two modes, kept apart
  // -------------------------------------------------------------------------

  /**
   * Cancel at period end.
   *
   * Sets the provider's `cancel_at_period_end` and records the intent as a field
   * on a row that is still active, still Pro, and still spending credit. This
   * method provisions nothing, expires nothing, and writes no status: the
   * transition happens later, when the provider reports the subscription out of
   * force. Reversible until then.
   */
  async cancelAtPeriodEnd(subscriptionId: string): Promise<SubscriptionModel> {
    const subscription = await this.requireLivePaidSubscription(subscriptionId);

    const atProvider = await this.provider.cancelSubscriptionAtPeriodEnd(
      subscription.providerSubscriptionId,
    );

    return this.syncFromProvider(subscription.id, atProvider);
  }

  /**
   * Cancel immediately.
   *
   * A different provider operation from {@link cancelAtPeriodEnd}, deliberately
   * not the same call with a flag: Pro entitlement ends now rather than at the
   * period end, and the action is not reversible.
   *
   * No refund is requested — the provider seam offers none — and the `Payment`
   * rows for money already collected are not modified, voided, or annotated.
   * Only entitlement changes.
   */
  async cancelImmediately(subscriptionId: string): Promise<ProToFreeResult> {
    const subscription = await this.requireLivePaidSubscription(subscriptionId);

    const ended = await this.provider.cancelSubscriptionNow(
      subscription.providerSubscriptionId,
    );

    // The confirmed result is provider state, so the shared transition can be
    // entered from here. If this acknowledgement is lost, the webhook or
    // reconciliation reaches the same routine and it still happens once.
    return this.transitionProToFree({ subscriptionId, providerState: ended });
  }

  /**
   * Clears a pending period-end cancellation on the same provider subscription.
   * Nothing was ever cancelled, so nothing is being revived — which is also why
   * this applies to that mode alone: a subscription the provider has ended is
   * never returned to the live set, and the user would subscribe afresh.
   */
  async reactivate(subscriptionId: string): Promise<SubscriptionModel> {
    const subscription = await this.requireSubscription(subscriptionId);

    if (!subscription.plan.isPaid) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        'Only a paid subscription has a renewal to reactivate.',
        HttpStatus.CONFLICT,
      );
    }
    if (isTerminal(subscription.status)) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        `Subscription ${subscription.id} is ${subscription.status} at the ` +
          `provider. A cancelled subscription is never returned to the live ` +
          `set; subscribe again instead.`,
        HttpStatus.CONFLICT,
      );
    }

    const atProvider = await this.requireProviderSubscription(
      subscription.providerSubscriptionId,
    );
    if (!isLive(atProvider.status)) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        `The provider reports subscription ${atProvider.id} as ` +
          `${atProvider.status}. A cancelled subscription is never returned to ` +
          `the live set; subscribe again instead.`,
        HttpStatus.CONFLICT,
      );
    }
    if (!subscription.cancelAtPeriodEnd && !atProvider.cancelAtPeriodEnd) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        'This subscription has no pending period-end cancellation to clear.',
        HttpStatus.CONFLICT,
      );
    }

    const restored = await this.provider.reactivateSubscription(
      subscription.providerSubscriptionId,
    );

    return this.syncFromProvider(subscription.id, restored);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Projects a provider report onto the local row. Never the other way round. */
  private syncFromProvider(
    subscriptionId: string,
    atProvider: ProviderSubscription,
  ): Promise<SubscriptionModel> {
    return this.subscriptions.update(subscriptionId, {
      status: atProvider.status,
      cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
      currentPeriodStart: atProvider.currentPeriodStart,
      currentPeriodEnd: atProvider.currentPeriodEnd,
    });
  }

  private async requireSubscription(
    subscriptionId: string,
  ): Promise<SubscriptionWithCatalog> {
    const subscription = await this.subscriptions.findById(subscriptionId);
    if (!subscription) {
      throw new BillingException(
        ErrorCode.NotFound,
        'No such subscription.',
        HttpStatus.NOT_FOUND,
      );
    }
    return subscription;
  }

  private async requireLivePaidSubscription(
    subscriptionId: string,
  ): Promise<SubscriptionWithCatalog> {
    const subscription = await this.requireSubscription(subscriptionId);

    if (!isLive(subscription.status) || !subscription.plan.isPaid) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        `This operation needs a live paid subscription; subscription ` +
          `${subscription.id} is ${subscription.status} on the ` +
          `${subscription.plan.key} plan.`,
        HttpStatus.CONFLICT,
      );
    }
    return subscription;
  }

  private async requireProviderSubscription(
    providerSubscriptionId: string,
  ): Promise<ProviderSubscription> {
    const atProvider = await this.provider.getSubscription(
      providerSubscriptionId,
    );
    if (!atProvider) {
      throw new BillingException(
        ErrorCode.InvalidSubscriptionState,
        `The billing provider has no subscription ${providerSubscriptionId}.`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    return atProvider;
  }

  /**
   * Cancels the subscription an upgrade superseded. Post-commit and best-effort:
   * a failure here leaves an orphan at the provider for reconciliation, which is
   * strictly better than rolling back a paid upgrade.
   */
  private async cancelSupersededSubscription(
    superseded: SubscriptionModel,
  ): Promise<void> {
    try {
      await this.provider.cancelSubscriptionNow(
        superseded.providerSubscriptionId,
      );
    } catch (error) {
      this.logger.warn(
        `Superseded provider subscription ${superseded.providerSubscriptionId} ` +
          `could not be cancelled and is now an orphan: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
