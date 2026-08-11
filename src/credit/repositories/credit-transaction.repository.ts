import { Injectable } from '@nestjs/common';
import { CreditLedger, CreditTransaction, CreditTransactionType, Prisma } from '@prisma/client';
import { CursorBound, CursorWindow } from '@/common/pagination/cursor-window';

function boundOf(bound: CursorBound): Prisma.CreditTransactionWhereInput {
  if (bound.ties === 'all') return { createdAt: { lte: bound.at } };

  if (bound.ties === 'none') return { createdAt: { lt: bound.at } };

  return {
    OR: [{ createdAt: { lt: bound.at } }, { createdAt: bound.at, id: { lt: bound.id } }],
  };
}

function windowOf(window: CursorWindow): Prisma.CreditTransactionWhereInput[] {
  return [
    ...(window.from ? [{ createdAt: { gte: window.from } }] : []),
    ...(window.before ? [boundOf(window.before)] : []),
  ];
}

export interface NewLedgerRow {
  walletId: string;
  ledger: CreditLedger;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  reason?: string;
  idempotencyKey?: string;
  reversesId?: string;
  stripeInvoiceId?: string;
  periodStart?: Date;
}

@Injectable()
export class CreditTransactionRepository {
  create(tx: Prisma.TransactionClient, row: NewLedgerRow): Promise<CreditTransaction> {
    return tx.creditTransaction.create({ data: row });
  }

  findConsumptions(
    tx: Prisma.TransactionClient,
    walletId: string,
    idempotencyKey: string,
  ): Promise<CreditTransaction[]> {
    return tx.creditTransaction.findMany({
      where: { walletId, idempotencyKey, type: CreditTransactionType.CONSUMPTION },
    });
  }

  findAllocation(
    tx: Prisma.TransactionClient,
    walletId: string,
    idempotencyKey: string,
    ledger: CreditLedger,
  ): Promise<CreditTransaction | null> {
    return tx.creditTransaction.findFirst({
      where: { walletId, idempotencyKey, ledger, type: CreditTransactionType.ALLOCATION },
    });
  }

  findReversalsOf(
    tx: Prisma.TransactionClient,
    reversesIds: string[],
  ): Promise<CreditTransaction[]> {
    return tx.creditTransaction.findMany({ where: { reversesId: { in: reversesIds } } });
  }

  listForHistory(
    tx: Prisma.TransactionClient,
    walletId: string,
    window: CursorWindow,
  ): Promise<CreditTransaction[]> {
    return tx.creditTransaction.findMany({
      where: { walletId, AND: windowOf(window) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: window.limit,
    });
  }
}
