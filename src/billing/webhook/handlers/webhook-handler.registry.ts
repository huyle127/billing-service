import { Injectable } from '@nestjs/common';
import { SubscriptionTrialWillEndHandler } from './subscription-trial-will-end.handler';
import { WebhookHandler } from './webhook-handler.interface';

@Injectable()
export class WebhookHandlerRegistry {
  private readonly byEventType: Map<string, WebhookHandler>;

  constructor(subscriptionTrialWillEnd: SubscriptionTrialWillEndHandler) {
    this.byEventType = new Map(
      [subscriptionTrialWillEnd].map((handler) => [handler.eventType, handler]),
    );
  }

  handlerFor(eventType: string): WebhookHandler | undefined {
    return this.byEventType.get(eventType);
  }
}
