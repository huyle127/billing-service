import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BillingCustomerRepository } from '@/billing/repositories/billing-customer.repository';
import { PaymentMethodRepository } from '@/billing/repositories/payment-method.repository';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { StripePaymentMethod, StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { DEFERRALS, OUTCOME_STATUSES, RESOLVED, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { deferral, Resolution, WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

@Injectable()
export class PaymentMethodAttachedHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.paymentMethodAttached;

  constructor(
    private readonly methods: PaymentMethodRepository,
    private readonly customers: BillingCustomerRepository,
    private readonly stripe: StripeService,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    if (!event.objectId) return deferral(DEFERRALS.noObjectId);

    const retrieved = await this.stripe.retrievePaymentMethod(event.objectId);

    if (!retrieved) return deferral(DEFERRALS.goneFromStripe(event.objectId));

    return { status: RESOLVED, apply: (tx) => this.record(tx, retrieved) };
  }

  private async record(
    tx: Prisma.TransactionClient,
    retrieved: StripePaymentMethod,
  ): Promise<WebhookOutcome> {
    if (!retrieved.customerId) return deferral(DEFERRALS.unattached(retrieved.id));

    const customer = await this.customers.findByStripeCustomerIdWithin(tx, retrieved.customerId);

    if (!customer) return deferral(DEFERRALS.noCustomerOwner(retrieved.customerId));

    const held = await this.methods.countAttachedWithin(tx, customer.userId);

    await this.methods.record(tx, {
      userId: customer.userId,
      stripePaymentMethodId: retrieved.id,
      brand: retrieved.brand,
      last4: retrieved.last4,
      expMonth: retrieved.expMonth,
      expYear: retrieved.expYear,
      isDefault: held === 0,
    });

    return { status: OUTCOME_STATUSES.completed };
  }
}
