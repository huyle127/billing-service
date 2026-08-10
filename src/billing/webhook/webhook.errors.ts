import { WebhookOutcome } from './handlers/webhook-handler.interface';

export class IncompleteOutcomeRollback extends Error {
  constructor(readonly outcome: WebhookOutcome) {
    super(`Webhook handler reported ${outcome.status}`);
    this.name = new.target.name;
  }
}
