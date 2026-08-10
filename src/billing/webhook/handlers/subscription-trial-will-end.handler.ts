import { Injectable } from '@nestjs/common';
import { OUTCOME_STATUSES, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

@Injectable()
export class SubscriptionTrialWillEndHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.subscriptionTrialWillEnd;

  handle(): Promise<WebhookOutcome> {
    return Promise.resolve({ status: OUTCOME_STATUSES.completed });
  }
}
