import { Injectable } from '@nestjs/common';
import { BillingCycle, PaymentStatus, Prisma, Subscription } from '@prisma/client';
import { NotFoundError } from '@/common/errors/domain.exception';
import { ALLOCATION_REASONS, TRANSITION_REASONS } from '@/billing/billing.constants';
import { PaymentTransactionRepository } from '@/billing/repositories/payment-transaction.repository';
import { PlanRepository } from '@/billing/repositories/plan.repository';
import { SubscriptionRepository } from '@/billing/repositories/subscription.repository';
import { nextCreditAt } from '@/billing/services/credit-schedule';
import { SubscriptionAllocationService } from '@/billing/services/subscription-allocation.service';
import { SubscriptionLifecycleService } from '@/billing/services/subscription-lifecycle.service';
import { LIFECYCLE_EVENTS, UNCHANGED } from '@/billing/services/subscription-transitions';
import { StripeInvoice, StripeSubscription, StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { InvoicePeriod, InvoiceReadingService } from '../services/invoice-reading.service';
import { SubscriptionSyncService } from '../services/subscription-sync.service';
import { OUTCOME_STATUSES, RESOLVED, WEBHOOK_EVENT_TYPES } from '../webhook.constants';
import { Resolution, WebhookHandler, WebhookOutcome } from './webhook-handler.interface';

const COMPLETED: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

@Injectable()
export class InvoicePaidHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.invoicePaid;

  constructor(
    private readonly sync: SubscriptionSyncService,
    private readonly reading: InvoiceReadingService,
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly allocation: SubscriptionAllocationService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly plans: PlanRepository,
    private readonly payments: PaymentTransactionRepository,
  ) {
    super();
  }

  async resolve(event: StripeWebhookEvent): Promise<Resolution> {
    const lookup = await this.sync.retrieveForInvoice(event);

    if (lookup.status !== RESOLVED) return lookup;

    return {
      status: RESOLVED,
      apply: (tx) => this.settle(tx, lookup.invoice, lookup.retrieved, event),
    };
  }

  private async settle(
    tx: Prisma.TransactionClient,
    invoice: StripeInvoice,
    retrieved: StripeSubscription,
    event: StripeWebhookEvent,
  ): Promise<WebhookOutcome> {
    if (!this.reading.isPaid(invoice)) return COMPLETED;

    const period = this.reading.periodOf(invoice);

    if (!period) return COMPLETED;

    const synced = await this.sync.syncWithin(tx, retrieved);

    if (synced.status === OUTCOME_STATUSES.deferred) return synced;
    if (synced.status !== RESOLVED) return COMPLETED;

    const transition = await this.lifecycle.applyWithin(tx, {
      subscriptionId: synced.local.id,
      event: LIFECYCLE_EVENTS.renew,
      reason: TRANSITION_REASONS.renewed,
      stripeEventId: event.id,
      stripeStatus: retrieved.status,
    });

    if (transition === UNCHANGED) return COMPLETED;

    const local = await this.settlePending(tx, synced.local);

    if (this.reading.owesCredits(invoice)) {
      await this.grant(tx, local, period);
    }

    await this.subscriptions.writeBoundaries(tx, local.id, {
      paidThroughAt: period.end,
      nextCreditAt:
        local.cycle === BillingCycle.ANNUAL ? nextCreditAt(period.start, period.end) : undefined,
    });

    if (this.reading.movesMoney(invoice)) {
      await this.payments.recordInvoice(tx, {
        userId: local.userId,
        stripeInvoiceId: invoice.id,
        status: PaymentStatus.SUCCEEDED,
        amountCents: invoice.amountPaid,
        currency: invoice.currency,
        occurredAt: event.createdAt,
      });
    }

    return COMPLETED;
  }

  private settlePending(
    tx: Prisma.TransactionClient,
    local: Subscription,
  ): Promise<Subscription> {
    if (!local.pendingPlanId) return Promise.resolve(local);

    return this.subscriptions.settlePendingChange(
      tx,
      local.id,
      local.pendingPlanId,
      local.pendingCycle ?? local.cycle,
    );
  }

  private async grant(
    tx: Prisma.TransactionClient,
    local: Subscription,
    period: InvoicePeriod,
  ): Promise<void> {
    const plan = await this.plans.findById(tx, local.planId);

    if (!plan) throw new NotFoundError('This subscription names no plan', { id: local.planId });

    await this.allocation.grantMonth(tx, {
      userId: local.userId,
      subscriptionId: local.id,
      monthlyCredits: plan.monthlyCredits,
      month: period.start,
      reason: ALLOCATION_REASONS.invoicePaid,
    });
  }
}
