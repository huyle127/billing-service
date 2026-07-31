import { Injectable, Logger } from '@nestjs/common';
import { PaymentMethodsService } from '../../payment-methods/payment-methods.service';
import type { ProviderPaymentMethod } from '../../provider/billing-provider';
import type { WebhookOutcome } from '../webhook.service';

/**
 * `payment_method.attached`, `.detached`, and `.updated` — the events that keep
 * the mirror in step with the provider (`payment-method-mirror` → "Mirror
 * Refreshed By Webhook Events").
 *
 * An attachment or a change is applied by re-reading the customer's methods from
 * the provider rather than by projecting the event's payload. Two reasons, and
 * both are about being a mirror rather than a cache:
 *
 * - A method attached in the provider's dashboard produces an event this service
 *   has no prior row for, and the refresh creates it.
 * - Which method is *default* is a fact about the customer, not about the method
 *   the event carries, so a single payload cannot establish it. Projecting the
 *   event's `isDefault` would let an unrelated update clear a default.
 *
 * A detachment needs no such read: the method is gone, so the row goes.
 */
@Injectable()
export class PaymentMethodHandler {
  private readonly logger = new Logger(PaymentMethodHandler.name);

  constructor(private readonly paymentMethods: PaymentMethodsService) {}

  /** Attached and updated behave identically: both mean "re-read the truth". */
  handleAttachedOrUpdated(
    method: ProviderPaymentMethod,
  ): Promise<WebhookOutcome> {
    return this.refresh(method);
  }

  async handleDetached(method: ProviderPaymentMethod): Promise<WebhookOutcome> {
    // Idempotent by construction: a redelivery finds nothing left to remove and
    // reports that it changed nothing.
    const removed = await this.paymentMethods.forget(method.id);
    return removed > 0 ? 'processed' : 'ignored';
  }

  private async refresh(
    method: ProviderPaymentMethod,
  ): Promise<WebhookOutcome> {
    if (method.customerId) {
      const user = await this.paymentMethods.findUserByCustomerId(
        method.customerId,
      );
      if (!user) {
        this.logger.log(
          `Payment-method event for unknown provider customer ` +
            `${method.customerId}; recorded and ignored.`,
        );
        return 'ignored';
      }

      await this.paymentMethods.refreshFromProvider(user.id, method.customerId);
      return 'processed';
    }

    // No customer on the payload — an update to a method attached to nobody.
    // The descriptors can still be applied to a row we already hold.
    const patched = await this.paymentMethods.patchDescriptors(method);
    return patched ? 'processed' : 'ignored';
  }
}
