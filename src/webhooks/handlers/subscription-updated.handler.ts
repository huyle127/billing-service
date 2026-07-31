import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProviderSubscription } from '../../provider/billing-provider';
import { isLive, isTerminal } from '../../subscriptions/subscription-status';
import { SubscriptionEndedHandler } from './subscription-ended.handler';
import type { WebhookOutcome } from '../webhook.service';

/**
 * `customer.subscription.updated` — the projection of provider status onto the
 * local row, and nothing more. It grants no credit, expires none, and creates no
 * row: a subscription row comes into existence when money is collected, so an
 * update for a subscription this service has never seen is ignored rather than
 * used to invent one.
 *
 * An update that reports the subscription out of force is routed to the ended
 * handler instead of projected. Projecting it directly would move the row out of
 * the live set and leave the user with no subscription at all, which is the
 * failure the shared transition exists to prevent.
 */
@Injectable()
export class SubscriptionUpdatedHandler {
  private readonly logger = new Logger(SubscriptionUpdatedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ended: SubscriptionEndedHandler,
  ) {}

  async handle(atProvider: ProviderSubscription): Promise<WebhookOutcome> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: atProvider.id },
      select: { id: true, status: true },
    });

    if (!subscription) {
      this.logger.log(
        `Update for unknown provider subscription ${atProvider.id}; recorded ` +
          `and ignored. A later paid invoice still produces the correct state.`,
      );
      return 'ignored';
    }

    if (isTerminal(subscription.status)) {
      // Never revived, whatever the provider now says about it.
      return 'ignored';
    }

    if (!isLive(atProvider.status)) {
      return this.ended.handle(atProvider);
    }

    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: atProvider.status,
        cancelAtPeriodEnd: atProvider.cancelAtPeriodEnd,
        currentPeriodStart: atProvider.currentPeriodStart,
        currentPeriodEnd: atProvider.currentPeriodEnd,
      },
    });

    return 'processed';
  }
}
