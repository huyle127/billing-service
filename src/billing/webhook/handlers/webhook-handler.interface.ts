import { Prisma } from '@prisma/client';
import { StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { OUTCOME_STATUSES, RESOLVED, WebhookEventType } from '../webhook.constants';

export type Deferral = { status: typeof OUTCOME_STATUSES.deferred; detail: string };

export type Failure = { status: typeof OUTCOME_STATUSES.failed; detail: string };

export type WebhookOutcome = { status: typeof OUTCOME_STATUSES.completed } | Deferral | Failure;

export type TransactionalWrite = (tx: Prisma.TransactionClient) => Promise<WebhookOutcome>;

export type Resolution =
  | { status: typeof RESOLVED; apply: TransactionalWrite }
  | Deferral
  | Failure;

export function deferral(detail: string): Deferral {
  return { status: OUTCOME_STATUSES.deferred, detail };
}

export abstract class WebhookHandler {
  abstract readonly eventType: WebhookEventType;

  abstract resolve(event: StripeWebhookEvent): Promise<Resolution>;
}
