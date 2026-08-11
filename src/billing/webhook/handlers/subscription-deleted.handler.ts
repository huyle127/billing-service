import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TRANSITION_REASONS } from '@/billing/billing.constants';
import { SubscriptionLifecycleService } from '@/billing/services/subscription-lifecycle.service';
import { LIFECYCLE_EVENTS } from '@/billing/services/subscription-transitions';
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

const COMPLETED: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

@Injectable()
export class SubscriptionDeletedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.subscriptionDeleted;

  constructor(
    private readonly sync: SubscriptionSyncService,
    private readonly lifecycle: SubscriptionLifecycleService,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    const lookup = await this.sync.retrieveFor(event);

    if (lookup.status !== RESOLVED) return lookup;

    return {
      status: RESOLVED,
      apply: (tx) => this.expire(tx, lookup.retrieved, event),
    };
  }

  private async expire(
    tx: Prisma.TransactionClient,
    retrieved: StripeSubscription,
    event: StripeWebhookEvent,
  ): Promise<WebhookOutcome> {
    const synced = await this.sync.syncWithin(tx, retrieved);

    if (synced.status === OUTCOME_STATUSES.deferred) return synced;
    if (synced.status !== RESOLVED) return COMPLETED;

    await this.lifecycle.applyWithin(tx, {
      subscriptionId: synced.local.id,
      event: LIFECYCLE_EVENTS.expire,
      reason: TRANSITION_REASONS.expired,
      stripeEventId: event.id,
      stripeStatus: retrieved.status,
    });

    return COMPLETED;
  }
}
