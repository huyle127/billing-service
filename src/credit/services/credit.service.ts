import { Injectable } from '@nestjs/common';
import {
  CreditLedger,
  CreditTransaction,
  CreditTransactionType,
  Prisma,
  WalletStatus,
} from '@prisma/client';
import { NotFoundError, ValidationError } from '../../common/errors/domain.exception';
import { Metrics } from '../../common/metrics/metrics';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DECLINE_COUNTER,
  DECLINE_REASON_LABEL,
  DECLINE_REASONS,
  LEDGER_TRANSACTION,
} from '../credit.constants';
import { AdjustmentExceedsBalanceError, IdempotencyKeyReusedError } from '../credit.errors';
import { CreditTransactionRepository } from '../repositories/credit-transaction.repository';
import { CreditWalletRepository, LockedWallet } from '../repositories/credit-wallet.repository';
import { LedgerBalances, splitDraw } from './draw-split';

export interface ConsumeRequest {
  amount: number;
  idempotencyKey: string;
  reason?: string;
}

export interface LedgerRow {
  id: string;
  ledger: CreditLedger;
  amount: number;
}

export type ConsumeResult =
  | {
      success: true;
      consumed: LedgerBalances;
      balance: LedgerBalances;
      transactions: LedgerRow[];
    }
  | {
      success: false;
      reason: typeof DECLINE_REASONS.insufficientCredits;
      balance: LedgerBalances;
      required: number;
    }
  | { success: false; reason: typeof DECLINE_REASONS.billingFrozen; balance: LedgerBalances };

export interface ReverseResult {
  restored: LedgerBalances;
  balance: LedgerBalances;
  transactions: LedgerRow[];
}

export interface AllocateRequest {
  ledger: CreditLedger;
  amount: number;
  idempotencyKey: string;
  replacing: boolean;
  reason?: string;
  stripeInvoiceId?: string;
  periodStart?: Date;
}

export interface AllocateResult {
  balance: LedgerBalances;
  transaction: LedgerRow;
}

const DRAW_ORDER = [CreditLedger.SUBSCRIPTION, CreditLedger.ADDON] as const;

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function balancesOf(wallet: LockedWallet): LedgerBalances {
  return { subscription: wallet.subscriptionCredits, addon: wallet.addonCredits };
}

function rowOf(rows: CreditTransaction[], ledger: CreditLedger): CreditTransaction | undefined {
  return rows.find((row) => row.ledger === ledger);
}

function drawnFrom(consumptions: CreditTransaction[], ledger: CreditLedger): number {
  const row = rowOf(consumptions, ledger);

  return row ? -row.amount : 0;
}

function ledgerRowOf(row: CreditTransaction): LedgerRow {
  return { id: row.id, ledger: row.ledger, amount: row.amount };
}

function inDrawOrder(rows: CreditTransaction[]): LedgerRow[] {
  return DRAW_ORDER.flatMap((ledger) => {
    const row = rowOf(rows, ledger);

    return row ? [ledgerRowOf(row)] : [];
  });
}

function standingOn(balance: LedgerBalances, ledger: CreditLedger, amount: number): LedgerBalances {
  return ledger === CreditLedger.SUBSCRIPTION
    ? { ...balance, subscription: amount }
    : { ...balance, addon: amount };
}

function heldOn(balance: LedgerBalances, ledger: CreditLedger): number {
  return ledger === CreditLedger.SUBSCRIPTION ? balance.subscription : balance.addon;
}

function replayAllocation(row: CreditTransaction, wallet: LockedWallet): AllocateResult {
  return {
    balance: standingOn(balancesOf(wallet), row.ledger, row.balanceAfter),
    transaction: ledgerRowOf(row),
  };
}

@Injectable()
export class CreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: CreditWalletRepository,
    private readonly transactions: CreditTransactionRepository,
    private readonly metrics: Metrics,
  ) {}

  async consume(userId: string, request: ConsumeRequest): Promise<ConsumeResult> {
    const result = await this.consumeOnce(userId, request).catch((error: unknown) =>
      isIdempotencyConflict(error)
        ? this.consumeOnce(userId, request)
        : Promise.reject(error as Error),
    );

    if (!result.success) {
      this.metrics.increment(DECLINE_COUNTER, { [DECLINE_REASON_LABEL]: result.reason });
    }

    return result;
  }

  reverse(userId: string, idempotencyKey: string): Promise<ReverseResult> {
    return this.reverseOnce(userId, idempotencyKey).catch((error: unknown) =>
      isIdempotencyConflict(error)
        ? this.reverseOnce(userId, idempotencyKey)
        : Promise.reject(error as Error),
    );
  }

  async createWallet(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await this.wallets.create(tx, userId);
  }

  async allocate(
    tx: Prisma.TransactionClient,
    userId: string,
    request: AllocateRequest,
  ): Promise<AllocateResult> {
    if (request.replacing && request.ledger !== CreditLedger.SUBSCRIPTION) {
      throw new ValidationError('Add-on credits are never replaced', { ledger: request.ledger });
    }

    const wallet = await this.wallets.lockByUserId(tx, userId);

    if (!wallet) throw new NotFoundError('This user has no credit wallet');

    const already = await this.transactions.findAllocation(
      tx,
      wallet.id,
      request.idempotencyKey,
      request.ledger,
    );

    if (already) return replayAllocation(already, wallet);

    const opening = request.replacing
      ? await this.forfeit(tx, wallet, balancesOf(wallet))
      : balancesOf(wallet);

    return this.grant(tx, wallet, opening, request);
  }

  async reset(tx: Prisma.TransactionClient, userId: string): Promise<LedgerBalances> {
    const wallet = await this.wallets.lockByUserId(tx, userId);

    if (!wallet) throw new NotFoundError('This user has no credit wallet');

    const balance = await this.forfeit(tx, wallet, balancesOf(wallet));

    await this.wallets.setBalances(tx, wallet.id, balance);

    return balance;
  }

  adjust(userId: string, amount: number, reason: string): Promise<LedgerBalances> {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.wallets.lockByUserId(tx, userId);

      if (!wallet) throw new NotFoundError('This user has no credit wallet');

      const addon = wallet.addonCredits + amount;

      if (addon < 0) {
        throw new AdjustmentExceedsBalanceError(
          'This adjustment would take more add-on credits than the wallet holds',
          { addonCredits: wallet.addonCredits, amount },
        );
      }

      const balance = { ...balancesOf(wallet), addon };

      await this.transactions.create(tx, {
        walletId: wallet.id,
        ledger: CreditLedger.ADDON,
        type: CreditTransactionType.ADJUSTMENT,
        amount,
        balanceAfter: addon,
        reason,
      });

      await this.wallets.setBalances(tx, wallet.id, balance);

      return balance;
    }, LEDGER_TRANSACTION);
  }

  freeze(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    return this.setStatus(tx, userId, WalletStatus.FROZEN);
  }

  unfreeze(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    return this.setStatus(tx, userId, WalletStatus.ACTIVE);
  }

  private async setStatus(
    tx: Prisma.TransactionClient,
    userId: string,
    status: WalletStatus,
  ): Promise<void> {
    const wallet = await this.wallets.lockByUserId(tx, userId);

    if (!wallet) throw new NotFoundError('This user has no credit wallet');

    await this.wallets.setStatus(tx, wallet.id, status);
  }

  private async forfeit(
    tx: Prisma.TransactionClient,
    wallet: LockedWallet,
    balance: LedgerBalances,
  ): Promise<LedgerBalances> {
    if (balance.subscription === 0) return balance;

    await this.transactions.create(tx, {
      walletId: wallet.id,
      ledger: CreditLedger.SUBSCRIPTION,
      type: CreditTransactionType.RESET,
      amount: -balance.subscription,
      balanceAfter: 0,
    });

    return { ...balance, subscription: 0 };
  }

  private async grant(
    tx: Prisma.TransactionClient,
    wallet: LockedWallet,
    opening: LedgerBalances,
    request: AllocateRequest,
  ): Promise<AllocateResult> {
    const balance = standingOn(
      opening,
      request.ledger,
      heldOn(opening, request.ledger) + request.amount,
    );

    const row = await this.transactions.create(tx, {
      walletId: wallet.id,
      ledger: request.ledger,
      type: CreditTransactionType.ALLOCATION,
      amount: request.amount,
      balanceAfter: heldOn(balance, request.ledger),
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
      stripeInvoiceId: request.stripeInvoiceId,
      periodStart: request.periodStart,
    });

    await this.wallets.setBalances(tx, wallet.id, balance);

    return { balance, transaction: ledgerRowOf(row) };
  }

  private consumeOnce(userId: string, request: ConsumeRequest): Promise<ConsumeResult> {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.wallets.lockByUserId(tx, userId);

      if (!wallet) throw new NotFoundError('This user has no credit wallet');

      const already = await this.transactions.findConsumptions(
        tx,
        wallet.id,
        request.idempotencyKey,
      );

      if (already.length) return this.replay(already, wallet, request);

      if (wallet.status === WalletStatus.FROZEN) {
        return {
          success: false,
          reason: DECLINE_REASONS.billingFrozen,
          balance: balancesOf(wallet),
        };
      }

      const split = splitDraw(request.amount, balancesOf(wallet));

      if (!split.sufficient) {
        return {
          success: false,
          reason: DECLINE_REASONS.insufficientCredits,
          balance: balancesOf(wallet),
          required: request.amount,
        };
      }

      return this.deduct(
        tx,
        wallet,
        { subscription: split.subscription, addon: split.addon },
        request,
      );
    }, LEDGER_TRANSACTION);
  }

  private reverseOnce(userId: string, idempotencyKey: string): Promise<ReverseResult> {
    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.wallets.lockByUserId(tx, userId);

      if (!wallet) throw new NotFoundError('This user has no credit wallet');

      const consumed = await this.transactions.findConsumptions(tx, wallet.id, idempotencyKey);

      if (!consumed.length) {
        throw new NotFoundError('No consumption carries this idempotency key', { idempotencyKey });
      }

      const already = await this.transactions.findReversalsOf(
        tx,
        consumed.map((row) => row.id),
      );

      return already.length
        ? this.replayReversal(already, wallet)
        : this.restore(tx, wallet, consumed);
    }, LEDGER_TRANSACTION);
  }

  private async restore(
    tx: Prisma.TransactionClient,
    wallet: LockedWallet,
    consumed: CreditTransaction[],
  ): Promise<ReverseResult> {
    const restored: LedgerBalances = {
      subscription: drawnFrom(consumed, CreditLedger.SUBSCRIPTION),
      addon: drawnFrom(consumed, CreditLedger.ADDON),
    };
    const balance: LedgerBalances = {
      subscription: wallet.subscriptionCredits + restored.subscription,
      addon: wallet.addonCredits + restored.addon,
    };

    const written: CreditTransaction[] = [];

    for (const ledger of DRAW_ORDER) {
      const original = rowOf(consumed, ledger);

      if (!original) continue;

      written.push(
        await this.transactions.create(tx, {
          walletId: wallet.id,
          ledger,
          type: CreditTransactionType.REVERSAL,
          amount: -original.amount,
          balanceAfter:
            ledger === CreditLedger.SUBSCRIPTION ? balance.subscription : balance.addon,
          reversesId: original.id,
        }),
      );
    }

    await this.wallets.setBalances(tx, wallet.id, balance);

    return { restored, balance, transactions: inDrawOrder(written) };
  }

  private replayReversal(rows: CreditTransaction[], wallet: LockedWallet): ReverseResult {
    const subscription = rowOf(rows, CreditLedger.SUBSCRIPTION);
    const addon = rowOf(rows, CreditLedger.ADDON);

    return {
      restored: { subscription: subscription?.amount ?? 0, addon: addon?.amount ?? 0 },
      balance: {
        subscription: subscription?.balanceAfter ?? wallet.subscriptionCredits,
        addon: addon?.balanceAfter ?? wallet.addonCredits,
      },
      transactions: inDrawOrder(rows),
    };
  }

  private async deduct(
    tx: Prisma.TransactionClient,
    wallet: LockedWallet,
    drawn: LedgerBalances,
    request: ConsumeRequest,
  ): Promise<ConsumeResult> {
    const balance: LedgerBalances = {
      subscription: wallet.subscriptionCredits - drawn.subscription,
      addon: wallet.addonCredits - drawn.addon,
    };

    const written: CreditTransaction[] = [];

    for (const ledger of DRAW_ORDER) {
      const amount = ledger === CreditLedger.SUBSCRIPTION ? drawn.subscription : drawn.addon;

      if (amount === 0) continue;

      written.push(
        await this.transactions.create(tx, {
          walletId: wallet.id,
          ledger,
          type: CreditTransactionType.CONSUMPTION,
          amount: -amount,
          balanceAfter:
            ledger === CreditLedger.SUBSCRIPTION ? balance.subscription : balance.addon,
          reason: request.reason,
          idempotencyKey: request.idempotencyKey,
        }),
      );
    }

    await this.wallets.setBalances(tx, wallet.id, balance);

    return { success: true, consumed: drawn, balance, transactions: inDrawOrder(written) };
  }

  private replay(
    rows: CreditTransaction[],
    wallet: LockedWallet,
    request: ConsumeRequest,
  ): ConsumeResult {
    const subscription = rowOf(rows, CreditLedger.SUBSCRIPTION);
    const addon = rowOf(rows, CreditLedger.ADDON);
    const consumed: LedgerBalances = {
      subscription: drawnFrom(rows, CreditLedger.SUBSCRIPTION),
      addon: drawnFrom(rows, CreditLedger.ADDON),
    };

    if (consumed.subscription + consumed.addon !== request.amount) {
      throw new IdempotencyKeyReusedError(
        'This idempotency key was already used for a different amount',
        { idempotencyKey: request.idempotencyKey },
      );
    }

    return {
      success: true,
      consumed,
      balance: {
        subscription: subscription?.balanceAfter ?? wallet.subscriptionCredits,
        addon: addon?.balanceAfter ?? wallet.addonCredits,
      },
      transactions: inDrawOrder(rows),
    };
  }
}
