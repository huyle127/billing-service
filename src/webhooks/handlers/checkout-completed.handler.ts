import { Injectable, Logger } from '@nestjs/common';
import { AddonsService } from '../../addons/addons.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProviderCheckoutCompletion } from '../../provider/billing-provider';
import type { WebhookOutcome } from '../webhook.service';

/**
 * `checkout.session.completed` — what fulfils a one-time add-on purchase.
 *
 * The adapter has already refused anything that is not a paid, payment-mode
 * session, so what arrives here is money the provider says it collected. This
 * handler resolves it back to the purchase that started the checkout and hands
 * off to the fulfilment routine, which owns the atomicity of the payment
 * record, the grant, its ledger entry, and the purchase's completion.
 *
 * It creates no subscription-sourced grant and must never be made to:
 * `invoice.paid` remains the only webhook that allocates subscription credit
 * (`webhook-processing` → "Handled Events Are Explicit").
 */
@Injectable()
export class CheckoutCompletedHandler {
  private readonly logger = new Logger(CheckoutCompletedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly addons: AddonsService,
  ) {}

  async handle(checkout: ProviderCheckoutCompletion): Promise<WebhookOutcome> {
    // Resolved here rather than by letting `fulfilPurchase` throw: a session
    // this service did not start is not an error, it is someone else's
    // checkout on the same provider account.
    const purchase = await this.prisma.addonPurchase.findUnique({
      where: { providerCheckoutSessionId: checkout.sessionId },
      select: { id: true },
    });

    if (!purchase) {
      this.logger.log(
        `Checkout session ${checkout.sessionId} completed with no add-on ` +
          `purchase recorded against it; ignored.`,
      );
      return 'ignored';
    }

    if (!checkout.paymentIntentId) {
      // A paid add-on always carries one. Reaching here means the flow is not
      // what this handler was written for, and inventing an identifier would
      // put a fabricated value on the payment record.
      this.logger.warn(
        `Checkout session ${checkout.sessionId} is paid but reports no ` +
          `payment intent; add-on purchase ${purchase.id} left unfulfilled ` +
          `for inspection rather than fulfilled against a fabricated id.`,
      );
      return 'ignored';
    }

    // Idempotent within: the payment is keyed by its payment intent and the
    // grant by its purchase, so a redelivery re-reads both and writes neither.
    await this.addons.fulfilPurchase({
      providerCheckoutSessionId: checkout.sessionId,
      providerPaymentIntentId: checkout.paymentIntentId,
      amount: checkout.amountTotal,
      currency: checkout.currency,
      relatedEvent: {
        type: 'checkout.session.completed',
        id: checkout.sessionId,
      },
    });

    return 'processed';
  }
}
