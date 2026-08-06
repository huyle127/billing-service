import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

describe('ledger invariants enforced by the database', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function aUserWithWallet(subscriptionCredits: number, addonCredits: number) {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const wallet = await prisma.creditWallet.create({
      data: { userId: user.id, subscriptionCredits, addonCredits },
    });
    return { user, wallet };
  }

  it('requirements section 6 — a balance can never go negative', async () => {
    const { wallet } = await aUserWithWallet(10, 0);

    await expect(
      prisma.creditWallet.update({
        where: { id: wallet.id },
        data: { subscriptionCredits: { decrement: 11 } },
      }),
    ).rejects.toThrow();

    const after = await prisma.creditWallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(after.subscriptionCredits).toBe(10);
  });

  it('requirements section 3 — a user has at most one current subscription', async () => {
    const { user } = await aUserWithWallet(50, 0);
    const plan = await prisma.plan.findFirstOrThrow({ where: { code: 'free' } });

    await prisma.subscription.create({
      data: { userId: user.id, planId: plan.id, status: 'ACTIVE', cycle: 'MONTHLY' },
    });

    await expect(
      prisma.subscription.create({
        data: { userId: user.id, planId: plan.id, status: 'ACTIVE', cycle: 'MONTHLY' },
      }),
    ).rejects.toThrow();
  });

  it('a subscription awaiting payment authentication coexists with the current one', async () => {
    const { user } = await aUserWithWallet(50, 0);
    const free = await prisma.plan.findFirstOrThrow({ where: { code: 'free' } });
    const pro = await prisma.plan.findFirstOrThrow({
      where: { code: 'pro', cycle: 'MONTHLY' },
    });

    await prisma.subscription.create({
      data: { userId: user.id, planId: free.id, status: 'ACTIVE', cycle: 'MONTHLY' },
    });
    await prisma.subscription.create({
      data: { userId: user.id, planId: pro.id, status: 'PENDING', cycle: 'MONTHLY' },
    });

    const rows = await prisma.subscription.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2);
  });

  it('requirements section 6 — one consumption spans both ledgers under one key', async () => {
    const { wallet } = await aUserWithWallet(100, 50);
    const key = 'consume:job-1';

    await prisma.creditTransaction.create({
      data: {
        walletId: wallet.id,
        ledger: 'SUBSCRIPTION',
        type: 'CONSUMPTION',
        amount: -100,
        balanceAfter: 50,
        idempotencyKey: key,
      },
    });
    await prisma.creditTransaction.create({
      data: {
        walletId: wallet.id,
        ledger: 'ADDON',
        type: 'CONSUMPTION',
        amount: -20,
        balanceAfter: 30,
        idempotencyKey: key,
      },
    });

    await expect(
      prisma.creditTransaction.create({
        data: {
          walletId: wallet.id,
          ledger: 'ADDON',
          type: 'CONSUMPTION',
          amount: -20,
          balanceAfter: 30,
          idempotencyKey: key,
        },
      }),
    ).rejects.toThrow();

    const rows = await prisma.creditTransaction.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(2);
  });

  it('requirements section 6 — a consumption can be reversed at most once', async () => {
    const { wallet } = await aUserWithWallet(100, 0);
    const consumption = await prisma.creditTransaction.create({
      data: {
        walletId: wallet.id,
        ledger: 'SUBSCRIPTION',
        type: 'CONSUMPTION',
        amount: -30,
        balanceAfter: 70,
        idempotencyKey: 'consume:job-2',
      },
    });

    const reversal = {
      walletId: wallet.id,
      ledger: 'SUBSCRIPTION',
      type: 'REVERSAL',
      amount: 30,
      balanceAfter: 100,
      reversesId: consumption.id,
    } as const;

    await prisma.creditTransaction.create({ data: reversal });

    await expect(prisma.creditTransaction.create({ data: reversal })).rejects.toThrow();

    const rows = await prisma.creditTransaction.findMany({
      where: { reversesId: consumption.id },
    });
    expect(rows).toHaveLength(1);
  });

  it('each test starts from a truncated database', async () => {
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.creditTransaction.count()).toBe(0);
    expect(await prisma.plan.count()).toBeGreaterThan(0);
  });
});
