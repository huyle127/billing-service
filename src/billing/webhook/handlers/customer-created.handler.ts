import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BillingCustomerRepository } from '@/billing/repositories/billing-customer.repository';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { METADATA_KEYS } from '@/billing/stripe/stripe.constants';
import { StripeCustomer, StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import {
  DEFERRALS,
  OUTCOME_STATUSES,
  RESOLVED,
  WEBHOOK_EVENT_TYPES,
} from '../webhook.constants';
import {
  deferral,
  Resolution,
  WebhookHandler,
  WebhookOutcome,
} from './webhook-handler.interface';

@Injectable()
export class CustomerCreatedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.customerCreated;

  constructor(
    private readonly customers: BillingCustomerRepository,
    private readonly stripe: StripeService,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    if (!event.objectId) return deferral(DEFERRALS.noObjectId);

    const retrieved = await this.stripe.retrieveCustomer(event.objectId);

    if (!retrieved) return deferral(DEFERRALS.goneFromStripe(event.objectId));

    return { status: RESOLVED, apply: (tx) => this.attach(tx, retrieved) };
  }

  private async attach(
    tx: Prisma.TransactionClient,
    retrieved: StripeCustomer,
  ): Promise<WebhookOutcome> {
    const userId = retrieved.metadata[METADATA_KEYS.userId];

    if (!userId) return deferral(DEFERRALS.unlabelled(retrieved.id));

    const customer = await this.customers.findByUserIdWithin(tx, userId);

    if (!customer) return deferral(DEFERRALS.noLocalCustomer(userId));

    await this.customers.attachStripeCustomerWithin(
      tx,
      customer.id,
      retrieved.id,
    );

    return { status: OUTCOME_STATUSES.completed };
  }
}
