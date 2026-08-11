import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthModule } from '@/auth/auth.module';
import { BillingModule } from '@/billing/billing.module';
import { FakeStripeAdapter } from '@/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { CreditModule } from '@/credit/credit.module';
import { Clock } from '@/common/clock/clock';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { DomainExceptionFilter } from '@/common/errors/domain-exception.filter';
import { MetricsModule } from '@/common/metrics/metrics.module';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';

const PASSWORD = 'correct horse battery staple';
const TIED = new Date('2030-01-01T00:00:00.000Z');
const LATER = new Date('2030-01-01T01:00:00.000Z');
const FLOOR = TIED.toISOString();

interface HistoryRow {
  source: string;
  id: string;
  status?: string;
}

interface HistoryPage {
  items: HistoryRow[];
  nextCursor: string | null;
}

describe('the billing history surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        MetricsModule,
        AuthModule,
        BillingModule,
        CreditModule,
      ],
    })
      .overrideProvider(StripeService)
      .useFactory({ factory: (clock: Clock) => new FakeStripeAdapter(clock), inject: [Clock] })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    baseUrl = await app.getUrl();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  function call(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function page(path: string, token: string): Promise<HistoryPage> {
    const response = await call(path, token);

    expect(response.status).toBe(200);

    return (await response.json()) as HistoryPage;
  }

  async function aUser(): Promise<{ token: string; userId: string }> {
    const email = `${crypto.randomUUID()}@example.test`;
    await fetch(`${baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });

    return { token: ((await login.json()) as { accessToken: string }).accessToken, userId: id };
  }

  async function aPayment(userId: string, occurredAt: Date, status: string): Promise<string> {
    const row = await prisma.paymentTransaction.create({
      data: {
        userId,
        kind: 'ADDON',
        status: status as 'PENDING',
        amountCents: 2000,
        currency: 'usd',
        occurredAt,
      },
    });

    return row.id;
  }

  async function aCreditRow(userId: string, createdAt: Date): Promise<string> {
    const wallet = await prisma.creditWallet.findUniqueOrThrow({ where: { userId } });
    const row = await prisma.creditTransaction.create({
      data: {
        walletId: wallet.id,
        ledger: 'ADDON',
        type: 'ALLOCATION',
        amount: 500,
        balanceAfter: 500,
        createdAt,
      },
    });

    return row.id;
  }

  async function aSubscriptionEvent(userId: string, occurredAt: Date): Promise<string> {
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { userId } });
    const row = await prisma.subscriptionEvent.create({
      data: { subscriptionId: subscription.id, type: 'RENEWED', occurredAt },
    });

    return row.id;
  }

  it('pages rows sharing one timestamp exactly once each, and holds a page steady against a write at the head', async () => {
    const { token, userId } = await aUser();
    const seeded = [
      await aPayment(userId, TIED, 'SUCCEEDED'),
      await aCreditRow(userId, TIED),
      await aSubscriptionEvent(userId, TIED),
    ].sort();

    const unpaged = await page(`/me/history?from=${FLOOR}&limit=10`, token);
    expect(unpaged.items).toHaveLength(3);
    expect(unpaged.nextCursor).toBeNull();

    const walked: string[] = [];
    let cursor: string | null = null;

    for (let read = 0; read < 3; read += 1) {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const next: HistoryPage = await page(`/me/history?from=${FLOOR}&limit=1${suffix}`, token);

      expect(next.items).toHaveLength(1);
      walked.push(next.items[0].id);
      cursor = next.nextCursor;
    }

    expect(cursor).toBeNull();
    expect([...walked].sort()).toEqual(seeded);
    expect(walked).toEqual(unpaged.items.map((row) => row.id));

    const first = await page(`/me/history?from=${FLOOR}&limit=1`, token);
    await aPayment(userId, LATER, 'SUCCEEDED');
    const second = await page(
      `/me/history?from=${FLOOR}&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      token,
    );

    expect(second.items.map((row) => row.id)).toEqual([unpaged.items[1].id]);
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it('filters to one source and shows a payment at every status', async () => {
    const { token, userId } = await aUser();

    await aPayment(userId, TIED, 'PENDING');
    await aPayment(userId, LATER, 'FAILED');
    await aPayment(userId, new Date('2030-01-01T02:00:00.000Z'), 'SUCCEEDED');
    const creditId = await aCreditRow(userId, TIED);

    const all = await page(`/me/history?from=${FLOOR}&limit=10`, token);
    expect(
      all.items.filter((row) => row.source === 'payment').map((row) => row.status).sort(),
    ).toEqual(['FAILED', 'PENDING', 'SUCCEEDED']);

    const credits = await page(`/me/history?from=${FLOOR}&limit=10&type=credit`, token);
    expect(credits.items.map((row) => row.id)).toEqual([creditId]);

    const forged = await call(`/me/history?from=${FLOOR}&type=invoice`, token);
    expect(forged.status).toBe(400);
  });
});
