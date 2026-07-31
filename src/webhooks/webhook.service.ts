import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-code';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type {
  BillingEvent,
  BillingProvider,
  ProviderEvent,
} from '../provider/billing-provider';
import { PrismaService } from '../prisma/prisma.service';
import { CheckoutCompletedHandler } from './handlers/checkout-completed.handler';
import { InvoicePaidHandler } from './handlers/invoice-paid.handler';
import { InvoicePaymentFailedHandler } from './handlers/invoice-payment-failed.handler';
import { PaymentMethodHandler } from './handlers/payment-method.handler';
import { SubscriptionEndedHandler } from './handlers/subscription-ended.handler';
import { SubscriptionUpdatedHandler } from './handlers/subscription-updated.handler';

/**
 * What became of one delivery. Every outcome is a success as far as the provider
 * is concerned — a non-2xx tells it to retry, and only `unverified` deserves
 * that (design D5, rule 3).
 */
export type WebhookOutcome =
  /** Effects applied. */
  | 'processed'
  /** Already processed; this delivery had no effect. */
  | 'duplicate'
  /** No handler for this event type; recorded and acknowledged. */
  | 'unhandled'
  /** Handled type, but nothing to act on — an unknown or terminal subscription. */
  | 'ignored';

export interface WebhookReceipt {
  eventId: string;
  outcome: WebhookOutcome;
  /**
   * The contract's code for this outcome, when there is one.
   *
   * A duplicate delivery carries `DUPLICATE_EVENT` and still answers `200`: the
   * provider is told the delivery was received, because a non-2xx would ask it
   * to retry an event that has already had its effects (design D5, rule 3). The
   * code names what happened without changing the acknowledgement.
   */
  code?: ErrorCode;
}

/**
 * Webhook intake.
 *
 * Three properties, each earned from a specific failure:
 *
 * - **The claim is an insert, not a lookup.** Two instances receiving the same
 *   delivery both try to insert the event id; the unique index decides. Checking
 *   "have I seen this?" first would lose that race.
 * - **Settlement is separate from the claim.** The row is inserted on arrival and
 *   marked processed only after the handler succeeds, so a crash in between
 *   leaves an unsettled row that redelivery re-runs. A claim that also meant
 *   "done" would silently drop the event the crash interrupted.
 * - **Exactly-once comes from the handlers, not from this file.** Each one is
 *   idempotent against a database key — the credit period, the invoice attempt,
 *   the provider subscription id — so a redelivery or a concurrent instance
 *   re-reads what it would have written. That is what makes settling outside the
 *   effects' transaction safe.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly invoicePaid: InvoicePaidHandler,
    private readonly invoiceFailed: InvoicePaymentFailedHandler,
    private readonly checkoutCompleted: CheckoutCompletedHandler,
    private readonly subscriptionUpdated: SubscriptionUpdatedHandler,
    private readonly subscriptionEnded: SubscriptionEndedHandler,
    private readonly paymentMethods: PaymentMethodHandler,
  ) {}

  /**
   * Verifies, records, dispatches. Throws only for an unverifiable delivery;
   * everything else is acknowledged, because a non-2xx asks the provider to
   * retry an event that will never succeed.
   */
  async receive(payload: Buffer, signature: string): Promise<WebhookReceipt> {
    // Before anything is written: an unsigned payload is not an event.
    const event = this.provider.verifyWebhookSignature(payload, signature);

    const alreadySettled = await this.claim(event);
    if (alreadySettled) {
      return {
        eventId: event.id,
        outcome: 'duplicate',
        code: ErrorCode.DuplicateEvent,
      };
    }

    if (!event.billing) {
      await this.settle(event.id);
      return { eventId: event.id, outcome: 'unhandled' };
    }

    const outcome = await this.dispatch(event.billing);
    await this.settle(event.id);
    return { eventId: event.id, outcome };
  }

  private dispatch(billing: BillingEvent): Promise<WebhookOutcome> {
    switch (billing.kind) {
      case 'invoice-paid':
        return this.invoicePaid.handle(billing.invoice);
      case 'invoice-payment-failed':
        return this.invoiceFailed.handle(billing.invoice);
      case 'checkout-completed':
        return this.checkoutCompleted.handle(billing.checkout);
      case 'subscription-updated':
        return this.subscriptionUpdated.handle(billing.subscription);
      case 'subscription-ended':
        return this.subscriptionEnded.handle(billing.subscription);
      case 'payment-method-attached':
      case 'payment-method-updated':
        return this.paymentMethods.handleAttachedOrUpdated(
          billing.paymentMethod,
        );
      case 'payment-method-detached':
        return this.paymentMethods.handleDetached(billing.paymentMethod);
    }
  }

  /**
   * Records the delivery and reports whether it was already processed.
   *
   * `skipDuplicates` is an `ON CONFLICT DO NOTHING`: the insert is the claim, and
   * the row that survives is the one every instance then reads.
   */
  private async claim(event: ProviderEvent): Promise<boolean> {
    await this.prisma.webhookEvent.createMany({
      data: [
        {
          providerEventId: event.id,
          type: event.type,
          payload: (event.raw ?? {}) as never,
        },
      ],
      skipDuplicates: true,
    });

    const recorded = await this.prisma.webhookEvent.findUnique({
      where: { providerEventId: event.id },
      select: { processedAt: true },
    });

    return recorded?.processedAt != null;
  }

  /**
   * Marks the event processed, and only if it is not already. Losing that
   * conditional update means a concurrent instance settled first — its effects
   * and this one's are the same effects, so there is nothing to undo.
   */
  private async settle(eventId: string): Promise<void> {
    const settled = await this.prisma.webhookEvent.updateMany({
      where: { providerEventId: eventId, processedAt: null },
      data: { processedAt: new Date() },
    });

    if (settled.count === 0) {
      this.logger.debug(
        `Event ${eventId} was settled concurrently; this delivery added nothing.`,
      );
    }
  }
}
