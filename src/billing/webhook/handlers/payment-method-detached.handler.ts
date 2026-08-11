import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../../../common/clock/clock';
import { PaymentMethodRepository } from '../../repositories/payment-method.repository';
import { StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { DEFERRALS, OUTCOME_STATUSES, RESOLVED, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { deferral, Resolution, WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

@Injectable()
export class PaymentMethodDetachedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.paymentMethodDetached;

  constructor(
    private readonly methods: PaymentMethodRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  resolve(event: StripeWebhookEvent): Promise<Resolution> {
    if (!event.objectId) return Promise.resolve(deferral(DEFERRALS.noObjectId));

    const paymentMethodId = event.objectId;

    return Promise.resolve({
      status: RESOLVED,
      apply: (tx: Prisma.TransactionClient) => this.forget(tx, paymentMethodId),
    });
  }

  private async forget(
    tx: Prisma.TransactionClient,
    paymentMethodId: string,
  ): Promise<WebhookOutcome> {
    await this.methods.markDetached(tx, paymentMethodId, this.clock.now());

    return { status: OUTCOME_STATUSES.completed };
  }
}
