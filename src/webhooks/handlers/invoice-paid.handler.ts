import { Inject, Injectable, Logger } from '@nestjs/common';
import { creditPolicyOf } from '../../catalog/credit-policy';
import { creditPeriodFrom } from '../../credits/credit-period';
import { CreditsService } from '../../credits/credits.service';
import { PaymentStatus } from '../../generated/prisma/enums';
import type { PlanModel } from '../../generated/prisma/models';
import { PaymentsService } from '../../payments/payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BILLING_PROVIDER } from '../../provider/billing-provider';
import type {
  BillingProvider,
  ProviderInvoice,
} from '../../provider/billing-provider';
import { SubscriptionLifecycleService } from '../../subscriptions/subscription-lifecycle.service';
import { isLive } from '../../subscriptions/subscription-status';
import type { WebhookOutcome } from '../webhook.service';

/**
 * `invoice.paid` — the authoritative event for subscription credit allocation,
 * and the **only** webhook that creates a subscription-sourced grant. The
 * scheduled reset is the one other allocator and is not a webhook at all.
 *
 * The subscription lookup is restricted to live rows. That is what makes a
 * terminal row structurally unrevivable by a late or zombie invoice, rather than
 * merely unintended: a Free Stripe subscription that was never cancelled keeps
 * emitting paid zero-amount invoices forever, and one of them must not resurrect
 * the row the user upgraded away from.
 */
@Injectable()
export class InvoicePaidHandler {
  private readonly logger = new Logger(InvoicePaidHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditsService,
    private readonly payments: PaymentsService,
    private readonly lifecycle: SubscriptionLifecycleService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  async handle(invoice: ProviderInvoice): Promise<WebhookOutcome> {
    if (!invoice.providerSubscriptionId) {
      // A one-off invoice with no subscription is not this handler's business.
      return 'ignored';
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: invoice.providerSubscriptionId },
      include: { plan: true },
    });

    if (!existing) {
      // No local row yet: this is the first paid invoice of a subscription the
      // user started at checkout, which is the moment the paid row comes into
      // existence (and never before).
      return this.startPaidSubscription(invoice);
    }

    if (!isLive(existing.status)) {
      this.logger.log(
        `Invoice ${invoice.id} belongs to terminal subscription ` +
          `${existing.id}; ignored rather than reviving it.`,
      );
      return 'ignored';
    }

    return this.renew(invoice, existing, existing.plan);
  }

  /**
   * The Free → Pro transition, driven by payment. Delegated whole: the routine
   * owns the atomicity of the Free row leaving the live set, the paid row
   * entering it, and the period's grant.
   */
  /**
   * The payment identifier for an invoice, asked for when the delivery did not
   * carry one.
   *
   * Stripe never puts it on a delivered invoice — `payments` is expandable and
   * an event carries no request with which to expand it — so without this the
   * column is null on every subscription payment. The conditional keeps this a
   * fallback: a payload that *does* carry one is used as it stands rather than
   * refetched.
   *
   * Deliberately not wrapped in a try/catch. A provider read that fails throws,
   * the delivery is answered non-2xx, and Stripe redelivers — the same
   * treatment `renew()` already gives its `getSubscription` read. Swallowing
   * the error would put back exactly the state this exists to remove: a null
   * that cannot be told apart from "the provider has none".
   */
  private async paymentIntentIdFor(
    invoice: ProviderInvoice,
  ): Promise<string | undefined> {
    if (invoice.paymentIntentId) {
      return invoice.paymentIntentId;
    }

    const retrieved = await this.provider.getInvoice(invoice.id);
    if (!retrieved?.paymentIntentId) {
      // The provider itself reports none. Recorded without one rather than
      // against a fabricated identifier, and said out loud, because a paid
      // invoice with no payment behind it is not an ordinary absence.
      this.logger.warn(
        `Invoice ${invoice.id} is paid but the provider reports no payment ` +
          `intent; the payment is recorded without one.`,
      );
      return undefined;
    }

    return retrieved.paymentIntentId;
  }

  private async startPaidSubscription(
    invoice: ProviderInvoice,
  ): Promise<WebhookOutcome> {
    if (!invoice.customerId || !invoice.priceId) {
      return 'ignored';
    }

    const user = await this.prisma.user.findUnique({
      where: { stripeCustomerId: invoice.customerId },
      select: { id: true },
    });
    const pricingOption = await this.prisma.pricingOption.findUnique({
      where: { stripePriceId: invoice.priceId },
      include: { plan: true },
    });

    if (!user || !pricingOption?.plan.isPaid) {
      // An unknown customer, or a Free subscription whose local row is gone.
      // Recorded and acknowledged: retrying will never make it succeed.
      this.logger.log(
        `Invoice ${invoice.id} references provider subscription ` +
          `${invoice.providerSubscriptionId} with no local counterpart; ignored.`,
      );
      return 'ignored';
    }

    // Read before the transition commits, and before any transaction opens.
    // This path made no provider call at all until now, so it gains a
    // dependency on Stripe being reachable: an outage here delays a Free → Pro
    // transition that would previously have completed. Accepted deliberately —
    // the event is idempotent and Stripe redelivers, so the transition is
    // delayed rather than lost, and recording a paid subscription whose payment
    // cannot be traced is the worse of the two outcomes.
    const providerPaymentIntentId = await this.paymentIntentIdFor(invoice);

    const relatedEvent = { type: 'invoice.paid', id: invoice.id };
    const subscription = await this.lifecycle.transitionFreeToPro({
      userId: user.id,
      productId: pricingOption.plan.productId,
      providerSubscriptionId: invoice.providerSubscriptionId!,
      relatedEvent,
    });

    await this.payments.recordRecurringPayment({
      userId: user.id,
      subscriptionId: subscription.id,
      amount: invoice.amountPaid,
      currency: invoice.currency,
      status: PaymentStatus.SUCCEEDED,
      providerInvoiceId: invoice.id,
      providerPaymentIntentId,
      attemptNumber: invoice.attemptCount,
    });

    return 'processed';
  }

  /**
   * A billing boundary on a subscription that already exists: record the
   * payment, allocate the credit period, and clear the dunning mirror.
   *
   * Recovery from `PAST_DUE` happens here too, but the status comes from the
   * provider rather than from the fact of payment — local status is a projection,
   * and a paid invoice is not by itself a report that the subscription is active.
   */
  private async renew(
    invoice: ProviderInvoice,
    subscription: { id: string; userId: string; productId: string },
    plan: PlanModel,
  ): Promise<WebhookOutcome> {
    // Read before the transaction opens, never inside it.
    const atProvider = await this.provider.getSubscription(
      invoice.providerSubscriptionId!,
    );
    const providerPaymentIntentId = await this.paymentIntentIdFor(invoice);

    const policy = creditPolicyOf(plan);
    // From the plan's policy, never the invoice's billing period: an annual
    // invoice pays for a year and grants one month.
    const period = creditPeriodFrom(
      invoice.periodStart ?? atProvider?.currentPeriodStart ?? new Date(),
      policy,
    );

    await this.prisma.$transaction(async (tx) => {
      await this.payments.recordRecurringPayment(
        {
          userId: subscription.userId,
          subscriptionId: subscription.id,
          amount: invoice.amountPaid,
          currency: invoice.currency,
          status: PaymentStatus.SUCCEEDED,
          providerInvoiceId: invoice.id,
          providerPaymentIntentId,
          attemptNumber: invoice.attemptCount,
        },
        tx,
      );

      await this.credits.allocateSubscriptionCredits(
        {
          userId: subscription.userId,
          productId: subscription.productId,
          subscriptionId: subscription.id,
          creditPeriodStart: period.start,
          creditPeriodEnd: period.end,
          amount: policy.creditsPerPeriod,
          relatedEvent: { type: 'invoice.paid', id: invoice.id },
        },
        tx,
      );

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          ...(atProvider && isLive(atProvider.status)
            ? {
                status: atProvider.status,
                cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
                currentPeriodStart: atProvider.currentPeriodStart,
                currentPeriodEnd: atProvider.currentPeriodEnd,
              }
            : {}),
          nextCreditResetAt: period.end,
          // The dunning mirror describes an unpaid invoice. This one is paid.
          paymentAttemptCount: 0,
          nextPaymentAttemptAt: null,
        },
      });
    });

    return 'processed';
  }
}
