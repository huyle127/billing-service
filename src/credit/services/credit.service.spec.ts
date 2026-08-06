import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { CreditLedger, WalletStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMetrics } from '../../common/metrics/in-memory-metrics';
import { MetricsModule } from '../../common/metrics/metrics.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditModule } from '../credit.module';
import { DECLINE_COUNTER, DECLINE_REASON_LABEL, DECLINE_REASONS } from '../credit.constants';
import { AdjustmentExceedsBalanceError, IdempotencyKeyReusedError } from '../credit.errors';
import { AllocateRequest, CreditService } from './credit.service';

describe('the credit ledger', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let credit: CreditService;
  let metrics: InMemoryMetrics;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, MetricsModule, CreditModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    credit = moduleRef.get(CreditService);
    metrics = moduleRef.get(InMemoryMetrics);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    metrics.reset();
  });

  async function aWallet(
    subscriptionCredits: number,
    addonCredits: number,
    status: WalletStatus = WalletStatus.ACTIVE,
  ) {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const wallet = await prisma.creditWallet.create({
      data: { userId: user.id, subscriptionCredits, addonCredits, status },
    });

    return { userId: user.id, walletId: wallet.id };
  }

  function balanceOf(walletId: string) {
    return prisma.creditWallet.findUniqueOrThrow({ where: { id: walletId } });
  }

  function declineCount(reason: string): number {
    return metrics.valueOf(DECLINE_COUNTER, { [DECLINE_REASON_LABEL]: reason });
  }

  function allocate(userId: string, request: AllocateRequest) {
    return prisma.$transaction((tx) => credit.allocate(tx, userId, request));
  }

  function freeze(userId: string) {
    return prisma.$transaction((tx) => credit.freeze(tx, userId));
  }

  function unfreeze(userId: string) {
    return prisma.$transaction((tx) => credit.unfreeze(tx, userId));
  }

  function rowsOf(walletId: string) {
    return prisma.creditTransaction.findMany({ where: { walletId } });
  }

  async function byType(walletId: string) {
    const rows = await rowsOf(walletId);

    return Object.fromEntries(
      rows.map((row) => [row.type, [row.amount, row.balanceAfter, row.idempotencyKey]]),
    );
  }

  it('deducts the whole amount and records the row it wrote', async () => {
    const { userId, walletId } = await aWallet(100, 0);

    const result = await credit.consume(userId, { amount: 30, idempotencyKey: 'job-1' });

    expect(result).toMatchObject({
      success: true,
      consumed: { subscription: 30, addon: 0 },
      balance: { subscription: 70, addon: 0 },
    });
    expect(result.success && result.transactions).toHaveLength(1);

    const rows = await prisma.creditTransaction.findMany({ where: { walletId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ledger: 'SUBSCRIPTION',
      type: 'CONSUMPTION',
      amount: -30,
      balanceAfter: 70,
      idempotencyKey: 'job-1',
    });
    expect(result.success && result.transactions[0]).toMatchObject({
      id: rows[0].id,
      ledger: 'SUBSCRIPTION',
      amount: -30,
    });
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 70,
      addonCredits: 0,
    });
  });

  it('deducts nothing when the amount exceeds both ledgers together', async () => {
    const { userId, walletId } = await aWallet(10, 5);

    const result = await credit.consume(userId, { amount: 20, idempotencyKey: 'job-2' });

    expect(result).toEqual({
      success: false,
      reason: DECLINE_REASONS.insufficientCredits,
      balance: { subscription: 10, addon: 5 },
      required: 20,
    });
    expect('transactions' in result).toBe(false);
    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(0);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 10,
      addonCredits: 5,
    });
  });

  it('spans both ledgers under one key, subscription first', async () => {
    const { userId, walletId } = await aWallet(100, 50);

    const result = await credit.consume(userId, { amount: 120, idempotencyKey: 'job-3' });

    expect(result).toMatchObject({
      success: true,
      consumed: { subscription: 100, addon: 20 },
      balance: { subscription: 0, addon: 30 },
    });

    const rows = await prisma.creditTransaction.findMany({ where: { walletId } });
    expect(
      Object.fromEntries(rows.map((row) => [row.ledger, [row.amount, row.balanceAfter]])),
    ).toEqual({ SUBSCRIPTION: [-100, 0], ADDON: [-20, 30] });
    expect(rows.every((row) => row.idempotencyKey === 'job-3')).toBe(true);
    expect(result.success && result.transactions).toHaveLength(2);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: 30,
    });
  });

  it('replays the first result for a repeated key and the same amount', async () => {
    const { userId, walletId } = await aWallet(100, 50);
    const request = { amount: 120, idempotencyKey: 'job-4' };

    const first = await credit.consume(userId, request);
    const second = await credit.consume(userId, request);

    expect(second).toEqual(first);
    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(2);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: 30,
    });
  });

  it('refuses a repeated key carrying a different amount, comparing the total', async () => {
    const { userId, walletId } = await aWallet(100, 50);

    await credit.consume(userId, { amount: 120, idempotencyKey: 'job-5' });

    await expect(
      credit.consume(userId, { amount: 40, idempotencyKey: 'job-5' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(2);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: 30,
    });
  });

  it('declines a shortfall and a frozen wallet distinctly', async () => {
    const short = await aWallet(3, 0);
    const frozen = await aWallet(40, 0, WalletStatus.FROZEN);

    expect(await credit.consume(short.userId, { amount: 10, idempotencyKey: 'job-6' })).toEqual({
      success: false,
      reason: DECLINE_REASONS.insufficientCredits,
      balance: { subscription: 3, addon: 0 },
      required: 10,
    });

    expect(await credit.consume(frozen.userId, { amount: 10, idempotencyKey: 'job-7' })).toEqual({
      success: false,
      reason: DECLINE_REASONS.billingFrozen,
      balance: { subscription: 40, addon: 0 },
    });
  });

  it('reports a frozen wallet as frozen even when it also holds too little', async () => {
    const { userId } = await aWallet(3, 0, WalletStatus.FROZEN);

    expect(await credit.consume(userId, { amount: 10, idempotencyKey: 'job-8' })).toMatchObject({
      reason: DECLINE_REASONS.billingFrozen,
    });
  });

  it('replays a success even after the wallet has been frozen', async () => {
    const { userId, walletId } = await aWallet(100, 0);
    const request = { amount: 30, idempotencyKey: 'job-9' };

    const original = await credit.consume(userId, request);
    await prisma.creditWallet.update({
      where: { id: walletId },
      data: { status: WalletStatus.FROZEN },
    });

    expect(await credit.consume(userId, request)).toEqual(original);

    expect(await credit.consume(userId, { amount: 30, idempotencyKey: 'job-10' })).toMatchObject({
      success: false,
      reason: DECLINE_REASONS.billingFrozen,
    });
    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(1);
  });

  it('replays a drawn ledger from its row and an untouched ledger as it now stands', async () => {
    const { userId, walletId } = await aWallet(100, 5);
    const request = { amount: 30, idempotencyKey: 'job-11' };

    await credit.consume(userId, request);
    await prisma.creditWallet.update({
      where: { id: walletId },
      data: { addonCredits: 105 },
    });

    expect(await credit.consume(userId, request)).toMatchObject({
      success: true,
      balance: { subscription: 70, addon: 105 },
    });
  });

  it('counts every decline by reason and counts nothing else', async () => {
    const short = await aWallet(3, 0);
    const frozen = await aWallet(40, 0, WalletStatus.FROZEN);
    const healthy = await aWallet(100, 0);

    await credit.consume(short.userId, { amount: 10, idempotencyKey: 'job-12' });
    await credit.consume(frozen.userId, { amount: 10, idempotencyKey: 'job-13' });
    await credit.consume(healthy.userId, { amount: 10, idempotencyKey: 'job-14' });

    expect(declineCount(DECLINE_REASONS.insufficientCredits)).toBe(1);
    expect(declineCount(DECLINE_REASONS.billingFrozen)).toBe(1);
  });

  it('counts nothing for a transaction that rolled back', async () => {
    const { userId } = await aWallet(100, 0);

    await credit.consume(userId, { amount: 30, idempotencyKey: 'job-15' });
    await expect(
      credit.consume(userId, { amount: 40, idempotencyKey: 'job-15' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);

    expect(metrics.snapshot()).toEqual({});
  });

  it('stores the caller reason on every row, and none when it was not supplied', async () => {
    const withReason = await aWallet(100, 50);
    const without = await aWallet(100, 0);

    await credit.consume(withReason.userId, {
      amount: 120,
      idempotencyKey: 'job-16',
      reason: 'image-generation',
    });
    await credit.consume(without.userId, { amount: 30, idempotencyKey: 'job-17' });

    const reasons = await prisma.creditTransaction.findMany({
      where: { walletId: withReason.walletId },
      select: { reason: true },
    });
    expect(reasons).toEqual([{ reason: 'image-generation' }, { reason: 'image-generation' }]);

    const none = await prisma.creditTransaction.findMany({
      where: { walletId: without.walletId },
      select: { reason: true },
    });
    expect(none).toEqual([{ reason: null }]);
  });

  it('refuses a caller with no wallet', async () => {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });

    await expect(
      credit.consume(user.id, { amount: 10, idempotencyKey: 'job-18' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reverses a two-ledger consumption back to both ledgers', async () => {
    const { userId, walletId } = await aWallet(100, 50);
    await credit.consume(userId, { amount: 120, idempotencyKey: 'job-19' });

    const result = await credit.reverse(userId, 'job-19');

    expect(result).toMatchObject({
      restored: { subscription: 100, addon: 20 },
      balance: { subscription: 100, addon: 50 },
    });
    expect(result.transactions).toHaveLength(2);
    expect('success' in result).toBe(false);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 100,
      addonCredits: 50,
    });

    const reversals = await prisma.creditTransaction.findMany({
      where: { walletId, type: 'REVERSAL' },
      include: { reverses: true },
    });
    expect(
      Object.fromEntries(
        reversals.map((row) => [row.ledger, [row.amount, row.reverses?.ledger]]),
      ),
    ).toEqual({ SUBSCRIPTION: [100, 'SUBSCRIPTION'], ADDON: [20, 'ADDON'] });
  });

  it('restores to the ledger the credits came from, not the first one', async () => {
    const { userId, walletId } = await aWallet(0, 50);
    await credit.consume(userId, { amount: 20, idempotencyKey: 'job-20' });

    const result = await credit.reverse(userId, 'job-20');

    expect(result.restored).toEqual({ subscription: 0, addon: 20 });
    expect(result.transactions).toHaveLength(1);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: 50,
    });
  });

  it('writes reversal rows carrying neither an idempotency key nor a reason', async () => {
    const { userId, walletId } = await aWallet(100, 0);
    await credit.consume(userId, {
      amount: 30,
      idempotencyKey: 'job-21',
      reason: 'image-generation',
    });

    await credit.reverse(userId, 'job-21');

    const reversals = await prisma.creditTransaction.findMany({
      where: { walletId, type: 'REVERSAL' },
      select: { idempotencyKey: true, reason: true },
    });
    expect(reversals).toEqual([{ idempotencyKey: null, reason: null }]);
  });

  it('replays the first reversal when the same key is reversed again', async () => {
    const { userId, walletId } = await aWallet(100, 50);
    await credit.consume(userId, { amount: 120, idempotencyKey: 'job-22' });

    const first = await credit.reverse(userId, 'job-22');
    const second = await credit.reverse(userId, 'job-22');

    expect(second).toEqual(first);
    expect(await prisma.creditTransaction.count({ where: { walletId, type: 'REVERSAL' } })).toBe(2);
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 100,
      addonCredits: 50,
    });
  });

  it('reverses into a frozen wallet, and refuses a key with no consumption', async () => {
    const { userId, walletId } = await aWallet(100, 0);
    await credit.consume(userId, { amount: 30, idempotencyKey: 'job-23' });
    await prisma.creditWallet.update({
      where: { id: walletId },
      data: { status: WalletStatus.FROZEN },
    });

    await credit.reverse(userId, 'job-23');

    expect(await balanceOf(walletId)).toMatchObject({ subscriptionCredits: 100 });

    await expect(credit.reverse(userId, 'never-consumed')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('commits a grant with the caller transaction and rolls it back with it', async () => {
    const { userId, walletId } = await aWallet(0, 0);

    const committed = await allocate(userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'grant-1',
      replacing: false,
    });

    expect(committed.balance).toEqual({ subscription: 200, addon: 0 });
    expect(await balanceOf(walletId)).toMatchObject({ subscriptionCredits: 200 });

    await expect(
      prisma.$transaction(async (tx) => {
        await credit.allocate(tx, userId, {
          ledger: CreditLedger.SUBSCRIPTION,
          amount: 50,
          idempotencyKey: 'grant-2',
          replacing: false,
        });

        throw new Error('the caller failed after granting');
      }),
    ).rejects.toThrow('the caller failed after granting');

    expect(await balanceOf(walletId)).toMatchObject({ subscriptionCredits: 200 });
    expect(await prisma.creditTransaction.findMany({ where: { idempotencyKey: 'grant-2' } })).toEqual(
      [],
    );

    const stranger = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    await expect(
      allocate(stranger.id, {
        ledger: CreditLedger.SUBSCRIPTION,
        amount: 10,
        idempotencyKey: 'grant-3',
        replacing: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('grants to the ledger it names and leaves the other one alone', async () => {
    const subscription = await aWallet(0, 40);
    const addon = await aWallet(30, 0);

    const granted = await allocate(subscription.userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'grant-4',
      replacing: false,
    });

    expect(granted.balance).toEqual({ subscription: 200, addon: 40 });

    const rows = await rowsOf(subscription.walletId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ledger: 'SUBSCRIPTION',
      type: 'ALLOCATION',
      amount: 200,
      balanceAfter: 200,
      idempotencyKey: 'grant-4',
    });
    expect(granted.transaction).toEqual({ id: rows[0].id, ledger: 'SUBSCRIPTION', amount: 200 });

    const bought = await allocate(addon.userId, {
      ledger: CreditLedger.ADDON,
      amount: 100,
      idempotencyKey: 'grant-5',
      replacing: false,
    });

    expect(bought.balance).toEqual({ subscription: 30, addon: 100 });
    expect(await rowsOf(addon.walletId)).toMatchObject([
      { ledger: 'ADDON', type: 'ALLOCATION', amount: 100, balanceAfter: 100 },
    ]);
  });

  it('grants nothing further for a repeated key and names the first row', async () => {
    const { userId, walletId } = await aWallet(0, 0);
    const request: AllocateRequest = {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'grant-6',
      replacing: false,
    };

    const first = await allocate(userId, request);
    const second = await allocate(userId, request);

    expect(second).toEqual(first);
    expect(await rowsOf(walletId)).toHaveLength(1);
    expect(await balanceOf(walletId)).toMatchObject({ subscriptionCredits: 200 });
  });

  it('grants twice for two keys the ledger cannot tell apart', async () => {
    const { userId, walletId } = await aWallet(0, 0);

    await allocate(userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'august-by-invoice',
      replacing: false,
    });
    const second = await allocate(userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'august-by-cron',
      replacing: false,
    });

    expect(second.balance).toEqual({ subscription: 400, addon: 0 });
    expect(await rowsOf(walletId)).toHaveLength(2);
  });

  it('records a Stripe invoice and a period start, and grants without either', async () => {
    const reconciled = await aWallet(0, 0);
    const bare = await aWallet(0, 0);
    const periodStart = new Date('2026-08-01T00:00:00.000Z');

    await allocate(reconciled.userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'grant-7',
      replacing: false,
      stripeInvoiceId: 'in_test_1',
      periodStart,
    });

    expect(await rowsOf(reconciled.walletId)).toMatchObject([
      { stripeInvoiceId: 'in_test_1', periodStart, idempotencyKey: 'grant-7' },
    ]);

    const granted = await allocate(bare.userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'grant-8',
      replacing: false,
    });

    expect(granted.balance).toEqual({ subscription: 200, addon: 0 });
    expect(await rowsOf(bare.walletId)).toMatchObject([
      { stripeInvoiceId: null, periodStart: null },
    ]);
  });

  it('lands a replacing grant on the plan amount and forfeits the remainder', async () => {
    const { userId, walletId } = await aWallet(30, 40);

    const renewed = await allocate(userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'renewal-1',
      replacing: true,
    });

    expect(renewed.balance).toEqual({ subscription: 200, addon: 40 });
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 200,
      addonCredits: 40,
    });
    expect(await byType(walletId)).toEqual({
      RESET: [-30, 0, null],
      ALLOCATION: [200, 200, 'renewal-1'],
    });
    expect((await rowsOf(walletId)).every((row) => row.ledger === 'SUBSCRIPTION')).toBe(true);
  });

  it('does not zero a balance twice when a replacing grant is retried', async () => {
    const { userId, walletId } = await aWallet(30, 0);
    const request: AllocateRequest = {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'renewal-2',
      replacing: true,
    };

    const first = await allocate(userId, request);
    const second = await allocate(userId, request);

    expect(second).toEqual(first);
    expect(await balanceOf(walletId)).toMatchObject({ subscriptionCredits: 200 });

    expect(await rowsOf(walletId)).toHaveLength(2);
    expect(await byType(walletId)).toEqual({
      RESET: [-30, 0, null],
      ALLOCATION: [200, 200, 'renewal-2'],
    });
  });

  it('adds a non-replacing grant, and refuses to replace the add-on ledger', async () => {
    const midCycle = await aWallet(30, 0);
    const bought = await aWallet(0, 50);

    const upgraded = await allocate(midCycle.userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'upgrade-1',
      replacing: false,
    });

    expect(upgraded.balance).toEqual({ subscription: 230, addon: 0 });
    expect(await rowsOf(midCycle.walletId)).toMatchObject([{ type: 'ALLOCATION', amount: 200 }]);

    await expect(
      allocate(bought.userId, {
        ledger: CreditLedger.ADDON,
        amount: 100,
        idempotencyKey: 'upgrade-2',
        replacing: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await rowsOf(bought.walletId)).toEqual([]);
    expect(await balanceOf(bought.walletId)).toMatchObject({ addonCredits: 50 });
  });

  it('forfeits what the subscription ledger holds and leaves add-on standing', async () => {
    const { userId, walletId } = await aWallet(120, 50);

    const balance = await prisma.$transaction((tx) => credit.reset(tx, userId));

    expect(balance).toEqual({ subscription: 0, addon: 50 });
    expect(await balanceOf(walletId)).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: 50,
    });
    expect(await rowsOf(walletId)).toMatchObject([
      {
        ledger: 'SUBSCRIPTION',
        type: 'RESET',
        amount: -120,
        balanceAfter: 0,
        idempotencyKey: null,
      },
    ]);
  });

  it('writes no row when there is nothing left to forfeit', async () => {
    const { userId, walletId } = await aWallet(0, 50);

    const balance = await prisma.$transaction((tx) => credit.reset(tx, userId));

    expect(balance).toEqual({ subscription: 0, addon: 50 });
    expect(await rowsOf(walletId)).toEqual([]);
    expect(await balanceOf(walletId)).toMatchObject({ addonCredits: 50 });
  });

  it('takes nothing and records nothing when a wallet is frozen', async () => {
    const { userId, walletId } = await aWallet(0, 50);

    await freeze(userId);

    expect(await balanceOf(walletId)).toMatchObject({
      status: WalletStatus.FROZEN,
      subscriptionCredits: 0,
      addonCredits: 50,
    });
    expect(await rowsOf(walletId)).toEqual([]);
  });

  it('refuses a draw the add-on ledger could satisfy, and allows it again once unfrozen', async () => {
    const { userId, walletId } = await aWallet(0, 50);

    await freeze(userId);

    expect(await credit.consume(userId, { amount: 10, idempotencyKey: 'job-24' })).toEqual({
      success: false,
      reason: DECLINE_REASONS.billingFrozen,
      balance: { subscription: 0, addon: 50 },
    });

    await unfreeze(userId);

    expect(await balanceOf(walletId)).toMatchObject({
      status: WalletStatus.ACTIVE,
      addonCredits: 50,
    });
    expect(await credit.consume(userId, { amount: 10, idempotencyKey: 'job-25' })).toMatchObject({
      success: true,
      balance: { subscription: 0, addon: 40 },
    });
  });

  it('changes nothing when a frozen wallet is frozen or an active one unfrozen', async () => {
    const frozen = await aWallet(20, 50, WalletStatus.FROZEN);
    const active = await aWallet(20, 50);

    await freeze(frozen.userId);
    await unfreeze(active.userId);

    expect(await balanceOf(frozen.walletId)).toMatchObject({
      status: WalletStatus.FROZEN,
      subscriptionCredits: 20,
      addonCredits: 50,
    });
    expect(await balanceOf(active.walletId)).toMatchObject({
      status: WalletStatus.ACTIVE,
      subscriptionCredits: 20,
      addonCredits: 50,
    });
    expect(await rowsOf(frozen.walletId)).toEqual([]);
    expect(await rowsOf(active.walletId)).toEqual([]);
  });

  it('lets a frozen wallet be allocated to, adjusted, and reset', async () => {
    const { userId, walletId } = await aWallet(30, 50, WalletStatus.FROZEN);

    const granted = await allocate(userId, {
      ledger: CreditLedger.SUBSCRIPTION,
      amount: 200,
      idempotencyKey: 'renewal-3',
      replacing: true,
    });
    expect(granted.balance).toEqual({ subscription: 200, addon: 50 });

    expect(await credit.adjust(userId, 25, 'goodwill')).toEqual({
      subscription: 200,
      addon: 75,
    });

    expect(await prisma.$transaction((tx) => credit.reset(tx, userId))).toEqual({
      subscription: 0,
      addon: 75,
    });

    expect(await balanceOf(walletId)).toMatchObject({
      status: WalletStatus.FROZEN,
      subscriptionCredits: 0,
      addonCredits: 75,
    });
  });

  it('credits and debits the add-on ledger alone, carrying the admin reason', async () => {
    const credited = await aWallet(80, 0);
    const debited = await aWallet(80, 100);

    expect(await credit.adjust(credited.userId, 100, 'support goodwill')).toEqual({
      subscription: 80,
      addon: 100,
    });
    expect(await rowsOf(credited.walletId)).toMatchObject([
      {
        ledger: 'ADDON',
        type: 'ADJUSTMENT',
        amount: 100,
        balanceAfter: 100,
        reason: 'support goodwill',
        idempotencyKey: null,
      },
    ]);

    expect(await credit.adjust(debited.userId, -40, 'duplicate purchase')).toEqual({
      subscription: 80,
      addon: 60,
    });
    expect(await balanceOf(debited.walletId)).toMatchObject({
      subscriptionCredits: 80,
      addonCredits: 60,
    });
  });

  it('refuses a debit larger than the add-on ledger and allows one down to zero', async () => {
    const tooLarge = await aWallet(80, 30);
    const exact = await aWallet(80, 30);

    await expect(credit.adjust(tooLarge.userId, -50, 'clawback')).rejects.toBeInstanceOf(
      AdjustmentExceedsBalanceError,
    );
    expect(await rowsOf(tooLarge.walletId)).toEqual([]);
    expect(await balanceOf(tooLarge.walletId)).toMatchObject({
      subscriptionCredits: 80,
      addonCredits: 30,
    });

    expect(await credit.adjust(exact.userId, -30, 'clawback')).toEqual({
      subscription: 80,
      addon: 0,
    });
    expect(await rowsOf(exact.walletId)).toMatchObject([
      { ledger: 'ADDON', type: 'ADJUSTMENT', amount: -30, balanceAfter: 0 },
    ]);
  });

  it('leaves the subscription ledger unreachable by any adjustment', async () => {
    const { userId, walletId } = await aWallet(80, 30);

    await credit.adjust(userId, 100, 'goodwill');
    await credit.adjust(userId, -40, 'clawback');
    await expect(credit.adjust(userId, -500, 'clawback')).rejects.toBeInstanceOf(
      AdjustmentExceedsBalanceError,
    );

    expect(await balanceOf(walletId)).toMatchObject({ subscriptionCredits: 80, addonCredits: 90 });
    expect((await rowsOf(walletId)).every((row) => row.ledger === CreditLedger.ADDON)).toBe(true);
  });
});
