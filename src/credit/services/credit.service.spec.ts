import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { WalletStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryMetrics } from '../../common/metrics/in-memory-metrics';
import { MetricsModule } from '../../common/metrics/metrics.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreditModule } from '../credit.module';
import { DECLINE_COUNTER, DECLINE_REASON_LABEL, DECLINE_REASONS } from '../credit.constants';
import { IdempotencyKeyReusedError } from '../credit.errors';
import { CreditService } from './credit.service';

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
});
