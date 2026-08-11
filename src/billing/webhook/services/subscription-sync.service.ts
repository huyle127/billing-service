import { Injectable } from '@nestjs/common';
import { Prisma, Subscription } from '@prisma/client';
import { PlanRepository } from '../../repositories/plan.repository';
import {
  StripeFieldWrite,
  SubscriptionRepository,
} from '../../repositories/subscription.repository';
import { StripeService } from '../../stripe/interfaces/stripe-adapter.interface';
import { METADATA_KEYS } from '../../stripe/stripe.constants';
import {
  StripeInvoice,
  StripeSubscription,
  StripeWebhookEvent,
} from '../../stripe/types/stripe.types';
import { Deferral, deferral } from '../handlers/webhook-handler.interface';
import { DEFERRALS, RESOLVED, SUPERSEDED } from '../webhook.constants';

export type RetrievedSubscription =
  { status: typeof RESOLVED; retrieved: StripeSubscription } | Deferral;

export type RetrievedInvoice =
  | { status: typeof RESOLVED; invoice: StripeInvoice; retrieved: StripeSubscription }
  | Deferral;

export type SyncedSubscription =
  | { status: typeof RESOLVED; local: Subscription }
  | { status: typeof SUPERSEDED }
  | Deferral;

type ResolvedFields = { status: typeof RESOLVED; fields: StripeFieldWrite };

@Injectable()
export class SubscriptionSyncService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly plans: PlanRepository,
    private readonly stripe: StripeService,
  ) {}

  async retrieveFor(event: StripeWebhookEvent): Promise<RetrievedSubscription> {
    if (!event.objectId) return deferral(DEFERRALS.noObjectId);

    const retrieved = await this.stripe.retrieveSubscription(event.objectId);

    if (!retrieved) return deferral(DEFERRALS.goneFromStripe(event.objectId));

    return { status: RESOLVED, retrieved };
  }

  async retrieveForInvoice(event: StripeWebhookEvent): Promise<RetrievedInvoice> {
    if (!event.objectId) return deferral(DEFERRALS.noObjectId);

    const invoice = await this.stripe.retrieveInvoice(event.objectId);

    if (!invoice) return deferral(DEFERRALS.goneFromStripe(event.objectId));
    if (!invoice.subscriptionId) return deferral(DEFERRALS.noInvoiceSubscription(invoice.id));

    const retrieved = await this.stripe.retrieveSubscription(invoice.subscriptionId);

    if (!retrieved) return deferral(DEFERRALS.goneFromStripe(invoice.subscriptionId));

    return { status: RESOLVED, invoice, retrieved };
  }

  async syncWithin(
    tx: Prisma.TransactionClient,
    retrieved: StripeSubscription,
  ): Promise<SyncedSubscription> {
    const localId = retrieved.metadata[METADATA_KEYS.subscriptionId];

    if (!localId) return deferral(DEFERRALS.unlabelled(retrieved.id));

    const local = await this.subscriptions.findById(tx, localId);

    if (!local) return deferral(DEFERRALS.noLocalSubscription(localId));
    if (this.isSuperseded(local, retrieved)) return { status: SUPERSEDED };

    const write = await this.stripeFieldsOf(tx, local, retrieved);

    if (write.status !== RESOLVED) return write;

    await this.subscriptions.writeStripeFields(tx, local.id, write.fields);

    return { status: RESOLVED, local };
  }

  private isSuperseded(
    local: Subscription,
    retrieved: StripeSubscription,
  ): boolean {
    if (!local.stripePeriodEnd || !retrieved.currentPeriodEnd) return false;

    return (
      retrieved.currentPeriodEnd.getTime() < local.stripePeriodEnd.getTime()
    );
  }

  private async stripeFieldsOf(
    tx: Prisma.TransactionClient,
    local: Subscription,
    retrieved: StripeSubscription,
  ): Promise<ResolvedFields | Deferral> {
    const fields: StripeFieldWrite = {
      stripeSubscriptionId: retrieved.id,
      stripePriceId: retrieved.priceId,
      stripeStatus: retrieved.status,
      stripePeriodEnd: retrieved.currentPeriodEnd ?? undefined,
    };

    if (!retrieved.priceId) return { status: RESOLVED, fields };

    const plan = await this.plans.findByStripePriceId(tx, retrieved.priceId);

    if (!plan) return deferral(DEFERRALS.noPlanForPrice(retrieved.priceId));
    if (plan.id === local.pendingPlanId) return { status: RESOLVED, fields };

    return { status: RESOLVED, fields: { ...fields, planId: plan.id } };
  }
}
