import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { isUniqueViolation } from '../common/prisma-errors';
import type { RelatedEvent } from '../common/related-event';
import { CreditTransactionType } from '../generated/prisma/enums';
import type { CreditGrantModel } from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';
import { CreditRepository } from './credit.repository';
import type { TransactionClient } from './credit.repository';
import {
  addonGrantKey,
  consumeKey,
  subscriptionAllocationKey,
  subscriptionDepartureExpiryKey,
  subscriptionPeriodExpiryKey,
} from './idempotency-key';
import {
  EntitlementState,
  freezeReasonFor,
  isSourceSpendable,
  spendableSources,
} from './spendability';

/**
 * Default drain priorities. These are *data* written at grant time, not a rule
 * in the consumption query — consumption orders by the stored column, so
 * changing a grant's priority changes its drain position with no code change.
 *
 * Subscription credit drains first because it expires at the end of its credit
 * period; add-on credit does not, so spending it last loses the user nothing.
 */
export const SUBSCRIPTION_GRANT_PRIORITY = 100;
export const ADDON_GRANT_PRIORITY = 200;

export interface AllocateSubscriptionCreditsInput {
  userId: string;
  productId: string;
  subscriptionId: string;
  creditPeriodStart: Date;
  creditPeriodEnd: Date;
  amount: number;
  priority?: number;
  relatedEvent?: RelatedEvent;
}

export interface AllocationResult {
  grant: CreditGrantModel;
  /** False when another path had already claimed this credit period. */
  created: boolean;
}

export interface GrantAddonCreditsInput {
  userId: string;
  productId: string;
  addonPurchaseId: string;
  amount: number;
  priority?: number;
  relatedEvent?: RelatedEvent;
}

export interface ConsumeInput {
  userId: string;
  productId: string;
  requestId: string;
  amount: number;
  entitlement: EntitlementState;
  relatedEvent?: RelatedEvent;
}

export interface ConsumptionEntry {
  grantId: string;
  amount: number;
  grantAmountRemainingAfter: number;
}

export interface ConsumeResult {
  operationId: string;
  amount: number;
  entries: ConsumptionEntry[];
  /** True when this call matched an already-recorded consumption. */
  deduplicated: boolean;
}

export interface CreditBalance {
  spendable: number;
  frozen: number;
  total: number;
  freezeReason: ReturnType<typeof freezeReasonFor>;
}

/**
 * Owns credit. Every movement is written to the ledger in the same transaction
 * as the grant change it describes — the two are never split, because the
 * ledger is the source of truth and `amountRemaining` is only its projection.
 *
 * Transaction boundaries live here rather than in {@link CreditRepository}: the
 * repository is handed a client and never opens one, so a refusal raised
 * mid-transaction still rolls the whole movement back.
 */
@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Allocation
  // -------------------------------------------------------------------------

  /**
   * The single allocation routine, keyed by `(subscriptionId,
   * creditPeriodStart)`. Both allocation paths write through it — the paid
   * invoice at a billing boundary, and the scheduled reset for a credit period
   * no invoice will cover — so neither needs to know whether the other has
   * run. The unique index is the arbiter when both fall due at once.
   *
   * The period's grant is inserted *first*, so it claims the period: if the
   * claim loses, the whole transaction rolls back and the prior period is not
   * expired twice.
   *
   * A caller mid-transaction — the Free → Pro transition, whose grant has to
   * commit with the rows that justify it — passes its own client. Doing so opts
   * out of the lost-race recovery below: a unique violation then aborts the
   * caller's transaction rather than being answered from the winning grant,
   * because nothing can be read inside an aborted transaction and the caller's
   * other effects are no longer valid anyway.
   */
  async allocateSubscriptionCredits(
    input: AllocateSubscriptionCreditsInput,
    tx?: TransactionClient,
  ): Promise<AllocationResult> {
    const existing = await this.credits.findPeriodGrant(
      input.subscriptionId,
      input.creditPeriodStart,
      tx,
    );
    if (existing) {
      return { grant: existing, created: false };
    }

    if (tx) {
      return this.allocateWithin(tx, input);
    }

    try {
      return await this.prisma.$transaction((transaction) =>
        this.allocateWithin(transaction, input),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // The other allocation path won the race. Its grant is the one that
      // counts, and this call completes without error.
      const grant = await this.credits.findPeriodGrant(
        input.subscriptionId,
        input.creditPeriodStart,
      );
      if (!grant) {
        throw error;
      }
      return { grant, created: false };
    }
  }

  private async allocateWithin(
    tx: TransactionClient,
    input: AllocateSubscriptionCreditsInput,
  ): Promise<AllocationResult> {
    const operationId = randomUUID();

    const grant = await this.credits.insertSubscriptionGrant(tx, {
      userId: input.userId,
      productId: input.productId,
      amount: input.amount,
      priority: input.priority ?? SUBSCRIPTION_GRANT_PRIORITY,
      creditPeriodStart: input.creditPeriodStart,
      creditPeriodEnd: input.creditPeriodEnd,
      subscriptionId: input.subscriptionId,
    });

    // Unspent credit from the period that just ended does not roll over.
    await this.expireGrants(tx, {
      subscriptionId: input.subscriptionId,
      beforeCreditPeriodStart: input.creditPeriodStart,
      idempotencyKey: subscriptionPeriodExpiryKey(
        input.subscriptionId,
        input.creditPeriodStart,
      ),
      relatedEvent: input.relatedEvent,
    });

    await this.credits.recordLedgerEntry(tx, {
      creditGrantId: grant.id,
      operationId,
      idempotencyKey: subscriptionAllocationKey(
        input.subscriptionId,
        input.creditPeriodStart,
      ),
      type: CreditTransactionType.ALLOCATION,
      amount: input.amount,
      grantAmountRemainingAfter: input.amount,
      relatedEventType: input.relatedEvent?.type,
      relatedEventId: input.relatedEvent?.id,
    });

    return { grant, created: true };
  }

  /**
   * Add-on credit, granted only once per purchase.
   *
   * Add-on fulfilment passes its own transaction so the grant, the payment
   * record, and the purchase's completion commit together — a state with the
   * payment recorded and the credit missing is one the buyer paid for and did
   * not receive.
   */
  async grantAddonCredits(
    input: GrantAddonCreditsInput,
    tx?: TransactionClient,
  ): Promise<CreditGrantModel> {
    const existing = await this.credits.findAddonGrant(
      input.addonPurchaseId,
      tx,
    );
    if (existing) {
      return existing;
    }

    if (tx) {
      return this.grantAddonWithin(tx, input);
    }

    try {
      return await this.prisma.$transaction((transaction) =>
        this.grantAddonWithin(transaction, input),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const grant = await this.credits.findAddonGrant(input.addonPurchaseId);
      if (!grant) {
        throw error;
      }
      return grant;
    }
  }

  private async grantAddonWithin(
    tx: TransactionClient,
    input: GrantAddonCreditsInput,
  ): Promise<CreditGrantModel> {
    const grant = await this.credits.insertAddonGrant(tx, {
      userId: input.userId,
      productId: input.productId,
      amount: input.amount,
      priority: input.priority ?? ADDON_GRANT_PRIORITY,
      addonPurchaseId: input.addonPurchaseId,
    });

    await this.credits.recordLedgerEntry(tx, {
      creditGrantId: grant.id,
      operationId: randomUUID(),
      idempotencyKey: addonGrantKey(input.addonPurchaseId),
      type: CreditTransactionType.ALLOCATION,
      amount: input.amount,
      grantAmountRemainingAfter: input.amount,
      relatedEventType: input.relatedEvent?.type,
      relatedEventId: input.relatedEvent?.id,
    });

    return grant;
  }

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  /**
   * Expires everything a departing Subscription granted. Called when a
   * Subscription stops providing its plan's entitlement — subscription credit
   * survives exactly as long as the subscription that conferred it.
   *
   * Add-on grants are deliberately untouched: they are frozen by the derived
   * rule, not expired. Freeze and expiry are different mechanisms applied to
   * different sources, and conflating them is the mistake this method's
   * filter exists to prevent (design D4b).
   *
   * The Pro → Free transition passes its own transaction client, so the expiry
   * commits with the row leaving the live set — the departure and the expiry it
   * causes are one movement, not two that a crash could separate.
   */
  async expireSubscriptionGrants(
    subscriptionId: string,
    relatedEvent?: RelatedEvent,
    tx?: TransactionClient,
  ): Promise<number> {
    const expire = (transaction: TransactionClient) =>
      this.expireGrants(transaction, {
        subscriptionId,
        idempotencyKey: subscriptionDepartureExpiryKey(subscriptionId),
        relatedEvent,
      });

    return tx ? expire(tx) : this.prisma.$transaction(expire);
  }

  /**
   * Zeroes unspent subscription-sourced grants and ledgers the movement.
   * Returns how many grants were touched.
   */
  private async expireGrants(
    tx: TransactionClient,
    options: {
      subscriptionId: string;
      beforeCreditPeriodStart?: Date;
      idempotencyKey: string;
      relatedEvent?: RelatedEvent;
    },
  ): Promise<number> {
    const grants = await this.credits.findExpirableGrants(
      tx,
      options.subscriptionId,
      options.beforeCreditPeriodStart,
    );

    if (grants.length === 0) {
      return 0;
    }

    const operationId = randomUUID();
    const expiredAt = new Date();

    for (const [index, grant] of grants.entries()) {
      await this.credits.expireGrant(tx, grant.id, expiredAt);

      await this.credits.recordLedgerEntry(tx, {
        creditGrantId: grant.id,
        operationId,
        idempotencyKey: index === 0 ? options.idempotencyKey : null,
        type: CreditTransactionType.EXPIRY,
        amount: -grant.amountRemaining,
        grantAmountRemainingAfter: 0,
        relatedEventType: options.relatedEvent?.type,
        relatedEventId: options.relatedEvent?.id,
      });
    }

    return grants.length;
  }

  // -------------------------------------------------------------------------
  // Consumption
  // -------------------------------------------------------------------------

  /**
   * Spends credit, product-scoped. Candidate grants are locked `FOR UPDATE` in
   * the same order they are drained, which serves determinism and deadlock
   * avoidance with one ordering.
   */
  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BillingException(
        ErrorCode.ValidationFailed,
        'Consumption amount must be a positive whole number.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const key = consumeKey(input.userId, input.productId, input.requestId);

    const replay = await this.findRecordedConsumption(key);
    if (replay) {
      return replay;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const sources = spendableSources(input.entitlement);
        const locked =
          sources.length === 0
            ? []
            : await this.credits.lockCandidateGrants(
                tx,
                input.userId,
                input.productId,
                sources,
              );

        const available = locked.reduce((sum, g) => sum + g.amountRemaining, 0);
        if (available < input.amount) {
          // Thrown inside the transaction so nothing is partially deducted.
          throw this.insufficientCredits(input, available);
        }

        const operationId = randomUUID();
        const entries: ConsumptionEntry[] = [];
        let outstanding = input.amount;

        for (const grant of locked) {
          if (outstanding === 0) {
            break;
          }
          const taken = Math.min(outstanding, grant.amountRemaining);
          const remainingAfter = grant.amountRemaining - taken;

          await this.credits.drainGrant(tx, grant.id, remainingAfter);

          await this.credits.recordLedgerEntry(tx, {
            creditGrantId: grant.id,
            operationId,
            // The first row carries the key and claims the operation.
            idempotencyKey: entries.length === 0 ? key : null,
            type: CreditTransactionType.CONSUMPTION,
            amount: -taken,
            grantAmountRemainingAfter: remainingAfter,
            relatedEventType: input.relatedEvent?.type,
            relatedEventId: input.relatedEvent?.id,
          });

          entries.push({
            grantId: grant.id,
            amount: taken,
            grantAmountRemainingAfter: remainingAfter,
          });
          outstanding -= taken;
        }

        return {
          operationId,
          amount: input.amount,
          entries,
          deduplicated: false,
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // A concurrent replay of the same request claimed the key first.
      const recorded = await this.findRecordedConsumption(key);
      if (!recorded) {
        throw error;
      }
      return recorded;
    }
  }

  private insufficientCredits(
    input: ConsumeInput,
    available: number,
  ): BillingException {
    const freezeReason = freezeReasonFor(input.entitlement);
    return new BillingException(
      ErrorCode.InsufficientCredits,
      freezeReason
        ? 'Credit consumption is currently frozen for this product.'
        : 'Insufficient credit for this product.',
      HttpStatus.PAYMENT_REQUIRED,
      { requested: input.amount, spendable: available, freezeReason },
    );
  }

  /** Rebuilds a previously recorded consumption from the ledger. */
  private async findRecordedConsumption(
    key: string,
  ): Promise<ConsumeResult | null> {
    const claim = await this.credits.findConsumptionClaim(key);
    if (!claim) {
      return null;
    }

    const rows = await this.credits.findLedgerRowsByOperation(
      claim.operationId,
    );

    return {
      operationId: claim.operationId,
      amount: rows.reduce((sum, row) => sum - row.amount, 0),
      entries: rows.map((row) => ({
        grantId: row.creditGrantId,
        amount: -row.amount,
        grantAmountRemainingAfter: row.grantAmountRemainingAfter,
      })),
      deduplicated: true,
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Spendable and frozen amounts are reported separately: a frozen balance is
   * preserved credit the user still owns, not zero.
   */
  async getBalance(
    userId: string,
    productId: string,
    entitlement: EntitlementState,
  ): Promise<CreditBalance> {
    const grants = await this.credits.findUnexpiredGrants(
      userId,
      productId,
      new Date(),
    );

    let spendable = 0;
    let frozen = 0;
    for (const grant of grants) {
      if (isSourceSpendable(grant.source, entitlement)) {
        spendable += grant.amountRemaining;
      } else {
        frozen += grant.amountRemaining;
      }
    }

    return {
      spendable,
      frozen,
      total: spendable + frozen,
      freezeReason: freezeReasonFor(entitlement),
    };
  }
}
