import { Injectable } from '@nestjs/common';
import type {
  CreditGrantSource,
  CreditTransactionType,
} from '../generated/prisma/enums';
import { CreditRepository } from './credit.repository';

export interface CreditHistoryEntry {
  id: string;
  /** Groups the rows of one movement: a consumption across three grants shares one. */
  operationId: string;
  type: CreditTransactionType;
  /**
   * Signed: positive allocates, negative consumes or expires. This *is* the
   * balance impact — there is no separate authoritative column for it (C6).
   */
  amount: number;
  grantId: string;
  grantSource: CreditGrantSource;
  /** The affected grant's remaining amount immediately after this movement. */
  grantBalanceAfter: number;
  /**
   * The user's product-scoped total after this movement, replayed from the
   * ledger at read time rather than read from a column. If it ever disagreed
   * with the grants' remaining amounts, the ledger would be the arbiter.
   */
  balanceAfter: number;
  relatedEventType: string | null;
  relatedEventId: string | null;
  createdAt: Date;
}

/**
 * Credit history, per user and Product.
 *
 * Ordered by the ledger's own sequence rather than by timestamp: rows written in
 * one transaction share a `createdAt`, so a running balance ordered by time
 * would be assembled differently on every read. A "reset" depends on that order
 * being right — it is not an entry type of its own, but the outgoing period's
 * expiry followed by the new period's allocation.
 */
@Injectable()
export class CreditHistoryService {
  constructor(private readonly credits: CreditRepository) {}

  async listCreditHistory(
    userId: string,
    productId: string,
  ): Promise<CreditHistoryEntry[]> {
    const rows = await this.credits.findLedgerForProduct(userId, productId);

    let balance = 0;
    return rows.map((row) => {
      balance += row.amount;

      return {
        id: row.id,
        operationId: row.operationId,
        type: row.type,
        amount: row.amount,
        grantId: row.creditGrant.id,
        grantSource: row.creditGrant.source,
        grantBalanceAfter: row.grantAmountRemainingAfter,
        balanceAfter: balance,
        relatedEventType: row.relatedEventType,
        relatedEventId: row.relatedEventId,
        createdAt: row.createdAt,
      };
    });
  }
}
