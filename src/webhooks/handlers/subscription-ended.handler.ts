import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ProviderSubscription } from '../../provider/billing-provider';
import { SubscriptionLifecycleService } from '../../subscriptions/subscription-lifecycle.service';
import { SubscriptionLookupService } from '../../subscriptions/subscription-lookup.service';
import { isLive } from '../../subscriptions/subscription-status';
import type { WebhookOutcome } from '../webhook.service';

/**
 * `customer.subscription.deleted` — the event that completes **both**
 * cancellation modes and exhausted dunning.
 *
 * It does none of the work itself. All three paths converge on the one
 * transition routine, entered here on provider-confirmed state, which is the
 * only reason the three can be said to produce the same outcome.
 *
 * Two deletions must produce nothing: one for a subscription with no local row,
 * and one for a Free subscription that an upgrade already superseded. The second
 * is the more dangerous — provisioning Free for it would give a paying user a
 * second live subscription.
 */
@Injectable()
export class SubscriptionEndedHandler {
  private readonly logger = new Logger(SubscriptionEndedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly subscriptions: SubscriptionLookupService,
  ) {}

  async handle(atProvider: ProviderSubscription): Promise<WebhookOutcome> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { providerSubscriptionId: atProvider.id },
      select: { id: true, userId: true, productId: true, status: true },
    });

    if (!subscription) {
      // Out-of-order delivery is normal, and a non-2xx would ask the provider
      // to retry an event that can never succeed.
      this.logger.log(
        `Deletion of unknown provider subscription ${atProvider.id}; ` +
          `recorded and ignored.`,
      );
      return 'ignored';
    }

    const live = await this.subscriptions.findLive(
      subscription.userId,
      subscription.productId,
    );

    if (live && live.id !== subscription.id) {
      // The user already holds a live subscription — this deletion is the
      // superseded Free subscription being tidied up after an upgrade.
      this.logger.log(
        `Provider subscription ${atProvider.id} was superseded; its deletion ` +
          `creates no new row because ${live.id} is live.`,
      );
      return 'ignored';
    }

    if (!isLive(subscription.status) && !live) {
      // Already terminal locally and the user has nothing live: the transition
      // still has to run, because it is what gives them a Free subscription.
      this.logger.log(
        `Provider subscription ${atProvider.id} is terminal locally with no ` +
          `live replacement; completing the transition.`,
      );
    }

    await this.lifecycle.transitionProToFree({
      subscriptionId: subscription.id,
      providerState: atProvider,
      relatedEvent: {
        type: 'customer.subscription.deleted',
        id: atProvider.id,
      },
    });

    return 'processed';
  }
}
