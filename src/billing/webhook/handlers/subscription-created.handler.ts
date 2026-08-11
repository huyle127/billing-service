import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StripeSubscription, StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { SubscriptionSyncService } from '../services/subscription-sync.service';
import {
  OUTCOME_STATUSES,
  RESOLVED,
  WEBHOOK_EVENT_TYPES,
} from '../webhook.constants';
import {
  Resolution,
  WebhookHandler,
  WebhookOutcome,
} from './webhook-handler.interface';

@Injectable()
export class SubscriptionCreatedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.subscriptionCreated;

  constructor(private readonly sync: SubscriptionSyncService) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    const lookup = await this.sync.retrieveFor(event);

    if (lookup.status !== RESOLVED) return lookup;

    return {
      status: RESOLVED,
      apply: (tx) => this.attach(tx, lookup.retrieved),
    };
  }

  private async attach(
    tx: Prisma.TransactionClient,
    retrieved: StripeSubscription,
  ): Promise<WebhookOutcome> {
    const synced = await this.sync.syncWithin(tx, retrieved);

    if (synced.status === OUTCOME_STATUSES.deferred) return synced;

    return { status: OUTCOME_STATUSES.completed };
  }
}
