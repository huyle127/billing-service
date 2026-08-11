import { Injectable } from '@nestjs/common';
import {
  CreditLedger,
  CreditTransactionType,
  PaymentKind,
  PaymentStatus,
  PaymentTransaction,
  SubscriptionEvent,
  SubscriptionEventType,
} from '@prisma/client';
import { CursorWindow } from '@/common/pagination/cursor-window';
import { CreditHistoryRow, CreditService } from '@/credit/services/credit.service';
import { HISTORY_PAGE, HISTORY_SOURCES, HistorySource, SOURCE_RANK } from '../billing.constants';
import { PaymentTransactionRepository } from '../repositories/payment-transaction.repository';
import { SubscriptionEventRepository } from '../repositories/subscription-event.repository';
import { HistoryPosition, comparePositions, decodeCursor, encodeCursor } from './history-cursor';

export type HistoryRow =
  | {
      source: 'payment';
      id: string;
      occurredAt: Date;
      kind: PaymentKind;
      status: PaymentStatus;
      amountCents: number;
      currency: string;
      description: string | null;
    }
  | {
      source: 'credit';
      id: string;
      occurredAt: Date;
      ledger: CreditLedger;
      type: CreditTransactionType;
      amount: number;
      balanceAfter: number;
      reason: string | null;
    }
  | {
      source: 'subscription';
      id: string;
      occurredAt: Date;
      eventType: SubscriptionEventType;
      reason: string | null;
    };

export interface HistoryPage {
  items: HistoryRow[];
  nextCursor: string | null;
}

export interface HistoryQuery {
  limit?: number;
  sources?: HistorySource[];
  from?: Date;
  cursor?: string;
}

function windowFor(
  source: HistorySource,
  limit: number,
  from?: Date,
  position?: HistoryPosition,
): CursorWindow {
  if (!position) return { limit, from };

  const rank = SOURCE_RANK[source] - SOURCE_RANK[position.source];

  if (rank < 0) return { limit, from, before: { at: position.occurredAt, ties: 'all' } };

  if (rank > 0) return { limit, from, before: { at: position.occurredAt, ties: 'none' } };

  return {
    limit,
    from,
    before: { at: position.occurredAt, ties: 'below', id: position.id },
  };
}

function paymentRow(row: PaymentTransaction): HistoryRow {
  return {
    source: 'payment',
    id: row.id,
    occurredAt: row.occurredAt,
    kind: row.kind,
    status: row.status,
    amountCents: row.amountCents,
    currency: row.currency,
    description: row.description,
  };
}

function creditRow(row: CreditHistoryRow): HistoryRow {
  return {
    source: 'credit',
    id: row.id,
    occurredAt: row.occurredAt,
    ledger: row.ledger,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
  };
}

function subscriptionRow(row: SubscriptionEvent): HistoryRow {
  return {
    source: 'subscription',
    id: row.id,
    occurredAt: row.occurredAt,
    eventType: row.type,
    reason: row.reason,
  };
}

@Injectable()
export class HistoryService {
  constructor(
    private readonly payments: PaymentTransactionRepository,
    private readonly events: SubscriptionEventRepository,
    private readonly credit: CreditService,
  ) {}

  async page(userId: string, query: HistoryQuery): Promise<HistoryPage> {
    const position = query.cursor ? decodeCursor(query.cursor) : undefined;
    const wanted = query.sources ?? [...HISTORY_SOURCES];
    const limit = query.limit ?? HISTORY_PAGE.defaultLimit;
    const reach = limit + 1;
    const windowOf = (source: HistorySource): CursorWindow =>
      windowFor(source, reach, query.from, position);

    const [payments, credits, events] = await Promise.all([
      wanted.includes('payment')
        ? this.payments.listForHistory(userId, windowOf('payment'))
        : Promise.resolve([]),
      wanted.includes('credit')
        ? this.credit.history(userId, windowOf('credit'))
        : Promise.resolve([]),
      wanted.includes('subscription')
        ? this.events.listForHistory(userId, windowOf('subscription'))
        : Promise.resolve([]),
    ]);

    const merged = [
      ...payments.map(paymentRow),
      ...credits.map(creditRow),
      ...events.map(subscriptionRow),
    ]
      .sort(comparePositions)
      .slice(0, reach);

    const items = merged.slice(0, limit);
    const last = items.at(-1);

    return {
      items,
      nextCursor: merged.length > limit && last ? encodeCursor(last) : null,
    };
  }
}
