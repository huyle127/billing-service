import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  CreditGrantSource,
  CreditTransactionType,
} from '../generated/prisma/enums';
import type {
  CreditGrantModel,
  CreditTransactionModel,
} from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';

export type TransactionClient = Prisma.TransactionClient;

/** A grant locked `FOR UPDATE`, carrying only what draining it needs. */
export interface LockedGrant {
  id: string;
  amountRemaining: number;
}

export interface SpendableGrantRow {
  source: CreditGrantSource;
  amountRemaining: number;
}

export interface InsertSubscriptionGrantInput {
  userId: string;
  productId: string;
  amount: number;
  priority: number;
  creditPeriodStart: Date;
  creditPeriodEnd: Date;
  subscriptionId: string;
}

export interface InsertAddonGrantInput {
  userId: string;
  productId: string;
  amount: number;
  priority: number;
  addonPurchaseId: string;
}

/** A ledger row with the grant it moved, for history reads. */
export type LedgerRowWithGrant = CreditTransactionModel & {
  creditGrant: { id: string; source: CreditGrantSource };
};

export interface LedgerEntryInput {
  creditGrantId: string;
  operationId: string;
  /** Null on every row of a movement except the one that claims the key. */
  idempotencyKey: string | null;
  type: CreditTransactionType;
  /** Signed: positive allocates, negative consumes or expires. */
  amount: number;
  grantAmountRemainingAfter: number;
  relatedEventType?: string;
  relatedEventId?: string;
}

/**
 * All credit data access, and the only place credit SQL lives.
 *
 * Every method that participates in a transaction takes the transaction client
 * as a parameter. This repository never opens a transaction of its own — the
 * calling service owns the boundary, because credit consumption depends on
 * failing as a unit: an insufficient-credit refusal is raised *inside* the
 * transaction so nothing is partially deducted, and the unique-violation replay
 * path depends on the whole transaction rolling back.
 *
 * Reads that a caller may run either standalone or inside someone else's
 * transaction take an optional client and fall back to the base one.
 */
@Injectable()
export class CreditRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: TransactionClient): TransactionClient | PrismaService {
    return tx ?? this.prisma;
  }

  // ---------------------------------------------------------------------------
  // Grant lookups
  // ---------------------------------------------------------------------------

  findPeriodGrant(
    subscriptionId: string,
    creditPeriodStart: Date,
    tx?: TransactionClient,
  ): Promise<CreditGrantModel | null> {
    return this.client(tx).creditGrant.findFirst({
      where: {
        subscriptionId,
        creditPeriodStart,
        source: CreditGrantSource.SUBSCRIPTION,
      },
    });
  }

  findAddonGrant(
    addonPurchaseId: string,
    tx?: TransactionClient,
  ): Promise<CreditGrantModel | null> {
    return this.client(tx).creditGrant.findFirst({
      where: { addonPurchaseId, source: CreditGrantSource.ADDON },
    });
  }

  /** Unexpired grants with credit left, for balance reporting. */
  findUnexpiredGrants(
    userId: string,
    productId: string,
    now: Date,
    tx?: TransactionClient,
  ): Promise<SpendableGrantRow[]> {
    return this.client(tx).creditGrant.findMany({
      where: {
        userId,
        productId,
        amountRemaining: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { source: true, amountRemaining: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Consumption
  // ---------------------------------------------------------------------------

  /**
   * Locks the grants a consumption may draw on, in the order it will drain
   * them.
   *
   * The ordering is the deadlock-avoidance strategy, not a presentation choice:
   * concurrent consumptions for the same user and product acquire the same rows
   * in the same sequence, so neither can hold what the other is waiting for.
   * Prisma cannot express `FOR UPDATE`, which is why this is raw SQL.
   */
  lockCandidateGrants(
    tx: TransactionClient,
    userId: string,
    productId: string,
    sources: CreditGrantSource[],
  ): Promise<LockedGrant[]> {
    // `sources` comes from the CreditGrantSource enum, never from request
    // input, but it is still bound as a parameter rather than interpolated.
    return tx.$queryRawUnsafe<LockedGrant[]>(
      `SELECT "id", "amount_remaining" AS "amountRemaining"
         FROM "credit_grants"
        WHERE "user_id" = $1::uuid
          AND "product_id" = $2::uuid
          AND "amount_remaining" > 0
          AND ("expires_at" IS NULL OR "expires_at" > now())
          AND "source"::text = ANY($3::text[])
        ORDER BY "priority" ASC, "expires_at" ASC NULLS LAST, "id" ASC
        FOR UPDATE`,
      userId,
      productId,
      sources,
    );
  }

  /** Sets a grant's remaining amount as a consumption drains it. */
  async drainGrant(
    tx: TransactionClient,
    grantId: string,
    amountRemaining: number,
  ): Promise<void> {
    await tx.creditGrant.update({
      where: { id: grantId },
      data: { amountRemaining },
    });
  }

  /**
   * The row that claims an idempotency key, if the operation already ran.
   * Deliberately non-transactional: it is read before the transaction opens and
   * again after one has aborted, and nothing can be read inside an aborted
   * transaction.
   */
  findConsumptionClaim(key: string): Promise<CreditTransactionModel | null> {
    return this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: key },
    });
  }

  /**
   * Every ledger row of one movement, in the sequence they were written.
   *
   * Ordered by the ledger's own sequence rather than by timestamp: rows written
   * in one transaction share a `createdAt`, so a replay ordered by time would
   * reconstruct the entries differently on each read.
   */
  findLedgerRowsByOperation(
    operationId: string,
  ): Promise<CreditTransactionModel[]> {
    return this.prisma.creditTransaction.findMany({
      where: { operationId },
      orderBy: { sequence: 'asc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Grant creation
  // ---------------------------------------------------------------------------

  insertSubscriptionGrant(
    tx: TransactionClient,
    input: InsertSubscriptionGrantInput,
  ): Promise<CreditGrantModel> {
    return tx.creditGrant.create({
      data: {
        userId: input.userId,
        productId: input.productId,
        source: CreditGrantSource.SUBSCRIPTION,
        amountInitial: input.amount,
        amountRemaining: input.amount,
        priority: input.priority,
        creditPeriodStart: input.creditPeriodStart,
        creditPeriodEnd: input.creditPeriodEnd,
        subscriptionId: input.subscriptionId,
      },
    });
  }

  insertAddonGrant(
    tx: TransactionClient,
    input: InsertAddonGrantInput,
  ): Promise<CreditGrantModel> {
    return tx.creditGrant.create({
      data: {
        userId: input.userId,
        productId: input.productId,
        source: CreditGrantSource.ADDON,
        amountInitial: input.amount,
        amountRemaining: input.amount,
        priority: input.priority,
        addonPurchaseId: input.addonPurchaseId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Expiry
  // ---------------------------------------------------------------------------

  /**
   * Subscription-sourced grants with credit left, oldest id first.
   *
   * Add-on grants are excluded by the `source` filter deliberately: they are
   * frozen by the derived rule, not expired.
   */
  findExpirableGrants(
    tx: TransactionClient,
    subscriptionId: string,
    beforeCreditPeriodStart?: Date,
  ): Promise<CreditGrantModel[]> {
    return tx.creditGrant.findMany({
      where: {
        subscriptionId,
        source: CreditGrantSource.SUBSCRIPTION,
        amountRemaining: { gt: 0 },
        ...(beforeCreditPeriodStart
          ? { creditPeriodStart: { lt: beforeCreditPeriodStart } }
          : {}),
      },
      orderBy: { id: 'asc' },
    });
  }

  async expireGrant(
    tx: TransactionClient,
    grantId: string,
    expiredAt: Date,
  ): Promise<void> {
    await tx.creditGrant.update({
      where: { id: grantId },
      data: { amountRemaining: 0, expiresAt: expiredAt },
    });
  }

  // ---------------------------------------------------------------------------
  // Ledger
  // ---------------------------------------------------------------------------

  /**
   * Writes one ledger row. Always called in the same transaction as the grant
   * change it describes — the ledger is the source of truth and
   * `amountRemaining` is only its projection, so the two are never split.
   */
  async recordLedgerEntry(
    tx: TransactionClient,
    entry: LedgerEntryInput,
  ): Promise<void> {
    await tx.creditTransaction.create({ data: entry });
  }

  /**
   * The whole ledger for one user and Product, oldest first, with each row's
   * grant attached so the caller can report the grant's source.
   *
   * Ordered by sequence for the same reason as
   * {@link findLedgerRowsByOperation}: rows written in one transaction share a
   * `createdAt`, so a running balance ordered by time would be assembled
   * differently on every read.
   */
  findLedgerForProduct(
    userId: string,
    productId: string,
  ): Promise<LedgerRowWithGrant[]> {
    return this.prisma.creditTransaction.findMany({
      // Product scope comes from the grant, which is where `productId` lives.
      where: { creditGrant: { userId, productId } },
      include: { creditGrant: { select: { id: true, source: true } } },
      orderBy: { sequence: 'asc' },
    });
  }
}
