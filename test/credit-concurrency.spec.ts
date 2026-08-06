import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreditModule } from '../src/credit/credit.module';
import { ConsumeResult, CreditService } from '../src/credit/services/credit.service';
import { MetricsModule } from '../src/common/metrics/metrics.module';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

const RACE_TIMEOUT = 60_000;
const CALLERS = 30;
const AMOUNT = 10;
const SUBSCRIPTION_CREDITS = 100;
const ADDON_CREDITS = 50;

describe('concurrent credit consumption', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let credit: CreditService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, MetricsModule, CreditModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    credit = moduleRef.get(CreditService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function aWallet(subscriptionCredits: number, addonCredits: number) {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });
    const wallet = await prisma.creditWallet.create({
      data: { userId: user.id, subscriptionCredits, addonCredits },
    });

    return { userId: user.id, walletId: wallet.id };
  }

  it('never oversells a wallet the callers collectively exceed', async () => {
    const { userId, walletId } = await aWallet(SUBSCRIPTION_CREDITS, ADDON_CREDITS);
    const affordable = (SUBSCRIPTION_CREDITS + ADDON_CREDITS) / AMOUNT;

    const results = await Promise.all(
      Array.from({ length: CALLERS }, (_unused, index) =>
        credit.consume(userId, { amount: AMOUNT, idempotencyKey: `race-${index}` }),
      ),
    );

    expect(results.filter((result) => result.success)).toHaveLength(affordable);
    expect(results.filter((result) => !result.success)).toHaveLength(CALLERS - affordable);
    expect(await prisma.creditWallet.findUniqueOrThrow({ where: { id: walletId } })).toMatchObject({
      subscriptionCredits: 0,
      addonCredits: 0,
    });
    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(
      SUBSCRIPTION_CREDITS / AMOUNT + ADDON_CREDITS / AMOUNT,
    );
  }, RACE_TIMEOUT);

  it('charges once when one key is retried in parallel', async () => {
    const { userId, walletId } = await aWallet(100, 0);
    const request = { amount: 30, idempotencyKey: 'race-retry' };

    const results = await Promise.all([
      credit.consume(userId, request),
      credit.consume(userId, request),
    ]);

    const ids = results.map((result: ConsumeResult) =>
      result.success ? result.transactions.map((row) => row.id) : [],
    );
    expect(ids[0]).toEqual(ids[1]);
    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(1);
    expect(await prisma.creditWallet.findUniqueOrThrow({ where: { id: walletId } })).toMatchObject({
      subscriptionCredits: 70,
    });
  }, RACE_TIMEOUT);
});
