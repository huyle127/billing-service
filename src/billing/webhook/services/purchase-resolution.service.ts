import { Injectable } from '@nestjs/common';
import { AddonPackage, PaymentStatus, PaymentTransaction, Prisma } from '@prisma/client';
import { PaymentTransactionRepository } from '@/billing/repositories/payment-transaction.repository';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { METADATA_KEYS } from '@/billing/stripe/stripe.constants';
import { StripePayment, StripeWebhookEvent } from '@/billing/stripe/types/stripe.types';
import { Deferral, deferral } from '../handlers/webhook-handler.interface';
import { DEFERRALS, RESOLVED, SETTLED } from '../webhook.constants';

export type RetrievedPayment = { status: typeof RESOLVED; payment: StripePayment } | Deferral;

export type PurchaseOfPackage = PaymentTransaction & { addonPackage: AddonPackage };

export type ResolvedPurchase =
  | { status: typeof RESOLVED; purchase: PurchaseOfPackage }
  | { status: typeof SETTLED }
  | Deferral;

@Injectable()
export class PurchaseResolutionService {
  constructor(
    private readonly payments: PaymentTransactionRepository,
    private readonly stripe: StripeService,
  ) {}

  async retrieveFor(event: StripeWebhookEvent): Promise<RetrievedPayment> {
    if (!event.objectId) return deferral(DEFERRALS.noObjectId);

    const payment = await this.stripe.retrieveOneTimePayment(event.objectId);

    if (!payment) return deferral(DEFERRALS.goneFromStripe(event.objectId));

    return { status: RESOLVED, payment };
  }

  async purchaseWithin(
    tx: Prisma.TransactionClient,
    payment: StripePayment,
  ): Promise<ResolvedPurchase> {
    const purchaseId = payment.metadata[METADATA_KEYS.purchaseId];

    if (!purchaseId) return deferral(DEFERRALS.unlabelled(payment.id));

    const purchase = await this.payments.findPurchaseWithin(tx, purchaseId);

    if (!purchase) return deferral(DEFERRALS.noLocalPurchase(purchaseId));
    if (purchase.status !== PaymentStatus.PENDING) return { status: SETTLED };

    const { addonPackage } = purchase;

    if (!addonPackage) return deferral(DEFERRALS.noPurchasePackage(purchase.id));

    return { status: RESOLVED, purchase: { ...purchase, addonPackage } };
  }
}
