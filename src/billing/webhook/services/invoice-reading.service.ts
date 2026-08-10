import { Injectable } from '@nestjs/common';
import { BILLING_REASONS, INVOICE_STATUSES } from '../../stripe/stripe.constants';
import { StripeInvoice } from '../../stripe/types/stripe.types';

const GRANTING_REASONS: readonly string[] = [
  BILLING_REASONS.subscriptionCreate,
  BILLING_REASONS.subscriptionCycle,
  BILLING_REASONS.subscriptionUpdate,
];

export interface InvoicePeriod {
  start: Date;
  end: Date | null;
}

@Injectable()
export class InvoiceReadingService {
  isPaid(invoice: StripeInvoice): boolean {
    return invoice.status === INVOICE_STATUSES.paid;
  }

  owesCredits(invoice: StripeInvoice): boolean {
    return (
      this.isPaid(invoice) &&
      invoice.billingReason !== null &&
      GRANTING_REASONS.includes(invoice.billingReason)
    );
  }

  movesMoney(invoice: StripeInvoice): boolean {
    return invoice.amountDue > 0;
  }

  periodOf(invoice: StripeInvoice): InvoicePeriod | null {
    return invoice.periodStart ? { start: invoice.periodStart, end: invoice.periodEnd } : null;
  }

  nextCreditAt(period: InvoicePeriod): Date {
    const next = new Date(period.start);

    next.setUTCMonth(next.getUTCMonth() + 1);

    return next;
  }
}
