import { Injectable } from '@nestjs/common';
import { CreditLedger, CreditTransaction, CreditTransactionType, Prisma } from '@prisma/client';

export interface NewLedgerRow {
  walletId: string;
  ledger: CreditLedger;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  reason?: string;
  idempotencyKey?: string;
  reversesId?: string;
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

  findReversalsOf(
    tx: Prisma.TransactionClient,
    reversesIds: string[],
  ): Promise<CreditTransaction[]> {
    return tx.creditTransaction.findMany({ where: { reversesId: { in: reversesIds } } });
  }
}
