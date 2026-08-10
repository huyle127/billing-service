import { Injectable } from '@nestjs/common';
import { WebhookStatus } from '@prisma/client';
import { Clock } from '../../../common/clock/clock';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { WebhookHandlerRegistry } from '../handlers/webhook-handler.registry';
import { WebhookOutcome } from '../handlers/webhook-handler.interface';
import { WebhookEventRepository } from '../repositories/webhook-event.repository';
import { OUTCOME_STATUSES, WEBHOOK_REASONS } from '../webhook.constants';
import { IncompleteOutcomeRollback } from '../webhook.errors';

const COMPLETED: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

@Injectable()
export class WebhookService {
  constructor(
    private readonly events: WebhookEventRepository,
    private readonly handlers: WebhookHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async ingest(event: StripeWebhookEvent): Promise<WebhookOutcome> {
    const recorded = await this.events.findByStripeEventId(event.id);
    if (recorded?.status === WebhookStatus.COMPLETED) return COMPLETED;

    const row = recorded ?? (await this.events.record(event, this.clock.now()));
    const outcome = await this.process(event);
    await this.markOutcome(row.id, outcome);

    return outcome;
  }

  private async process(event: StripeWebhookEvent): Promise<WebhookOutcome> {
    const handler = this.handlers.handlerFor(event.type);
    if (!handler) return COMPLETED;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const outcome = await handler.handle(tx, event);
        if (outcome.status !== OUTCOME_STATUSES.completed) {
          throw new IncompleteOutcomeRollback(outcome);
        }

        return outcome;
      });
    } catch (error) {
      if (error instanceof IncompleteOutcomeRollback) return error.outcome;

      return {
        status: OUTCOME_STATUSES.failed,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private markOutcome(id: string, outcome: WebhookOutcome): Promise<void> {
    const at = this.clock.now();

    if (outcome.status === OUTCOME_STATUSES.completed) return this.events.markCompleted(id, at);

    return this.events.markFailed(id, WEBHOOK_REASONS[outcome.status](outcome.detail), at);
  }
}
