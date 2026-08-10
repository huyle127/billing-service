import { Prisma } from '@prisma/client';
import { StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { OUTCOME_STATUSES, WebhookEventType } from '../webhook.constants';

export type WebhookOutcome =
  | { status: typeof OUTCOME_STATUSES.completed }
  | { status: typeof OUTCOME_STATUSES.deferred; detail: string }
  | { status: typeof OUTCOME_STATUSES.failed; detail: string };

export abstract class WebhookHandler {
  abstract readonly eventType: WebhookEventType;

  abstract handle(
    tx: Prisma.TransactionClient,
    event: StripeWebhookEvent,
  ): Promise<WebhookOutcome>;
}
