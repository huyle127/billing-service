import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role, WalletStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmin } from '../prisma/seed-admin';
import { AuthModule } from '../src/auth/auth.module';
import { TOKEN_TYPES } from '../src/auth/auth.constants';
import { AppConfigModule } from '../src/common/config/config.module';
import { configurations } from '../src/common/config/configuration';
import { DomainExceptionFilter } from '../src/common/errors/domain-exception.filter';
import { MetricsModule } from '../src/common/metrics/metrics.module';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CreditModule } from '../src/credit/credit.module';

const PASSWORD = 'correct horse battery staple';

describe('credit consumption over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        MetricsModule,
        AuthModule,
        CreditModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    baseUrl = await app.getUrl();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  function post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function aFundedCaller(
    subscriptionCredits = 100,
    addonCredits = 50,
    status: WalletStatus = WalletStatus.ACTIVE,
  ): Promise<{ accessToken: string; userId: string; walletId: string }> {
    const email = `${crypto.randomUUID()}@example.test`;
    await post('/auth/register', { email, password: PASSWORD });
    const login = await post('/auth/login', { email, password: PASSWORD });
    const { accessToken } = (await login.json()) as { accessToken: string };

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const wallet = await prisma.creditWallet.create({
      data: { userId: user.id, subscriptionCredits, addonCredits, status },
    });

    return { accessToken, userId: user.id, walletId: wallet.id };
  }

  async function anAdminToken(): Promise<string> {
    await seedAdmin(prisma);
    const login = await post('/auth/login', {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });

    return ((await login.json()) as { accessToken: string }).accessToken;
  }

  async function aCallerWithoutAWallet(): Promise<string> {
    const email = `${crypto.randomUUID()}@example.test`;
    await post('/auth/register', { email, password: PASSWORD });

    return (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
  }

  it('consumes, replays, and reverses across both ledgers', async () => {
    const { accessToken, walletId } = await aFundedCaller();

    const consumed = await post(
      '/credits/consume',
      { amount: 120, idempotencyKey: 'http-1', reason: 'image-generation' },
      accessToken,
    );
    const body = (await consumed.json()) as Record<string, unknown>;

    expect(consumed.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      consumed: { subscription: 100, addon: 20 },
      balance: { subscription: 0, addon: 30 },
    });
    expect(body.transactions).toHaveLength(2);

    const replayed = await post(
      '/credits/consume',
      { amount: 120, idempotencyKey: 'http-1', reason: 'image-generation' },
      accessToken,
    );
    expect(await replayed.json()).toEqual(body);

    const reversed = await post('/credits/reverse', { idempotencyKey: 'http-1' }, accessToken);
    const reversal = (await reversed.json()) as Record<string, unknown>;

    expect(reversed.status).toBe(200);
    expect(reversal).toMatchObject({
      restored: { subscription: 100, addon: 20 },
      balance: { subscription: 100, addon: 50 },
    });
    expect('success' in reversal).toBe(false);
    expect(await prisma.creditWallet.findUniqueOrThrow({ where: { id: walletId } })).toMatchObject({
      subscriptionCredits: 100,
      addonCredits: 50,
    });
  });

  it('reports a decline as a 200 carrying no transactions', async () => {
    const short = await aFundedCaller(3, 0);
    const frozen = await aFundedCaller(40, 0, WalletStatus.FROZEN);

    const insufficient = await post(
      '/credits/consume',
      { amount: 10, idempotencyKey: 'http-2' },
      short.accessToken,
    );
    const declined = (await insufficient.json()) as Record<string, unknown>;

    expect(insufficient.status).toBe(200);
    expect(declined).toEqual({
      success: false,
      reason: 'INSUFFICIENT_CREDITS',
      balance: { subscription: 3, addon: 0 },
      required: 10,
    });
    expect('transactions' in declined).toBe(false);

    const billingFrozen = await post(
      '/credits/consume',
      { amount: 10, idempotencyKey: 'http-3' },
      frozen.accessToken,
    );
    expect(await billingFrozen.json()).toEqual({
      success: false,
      reason: 'BILLING_FROZEN',
      balance: { subscription: 40, addon: 0 },
    });
  });

  it('renders a reused key as 400 in the error envelope', async () => {
    const { accessToken } = await aFundedCaller();

    await post('/credits/consume', { amount: 30, idempotencyKey: 'http-4' }, accessToken);
    const reused = await post(
      '/credits/consume',
      { amount: 40, idempotencyKey: 'http-4' },
      accessToken,
    );

    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
  });

  it('refuses a caller whose token is absent, malformed, expired, or a refresh token', async () => {
    const { accessToken, walletId, userId } = await aFundedCaller();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const expired = jwt.sign(
      { sub: user.id, email: user.email, role: Role.USER, tokenType: TOKEN_TYPES.access },
      { expiresIn: '-1s' },
    );
    const refresh = jwt.sign({
      sub: user.id,
      email: user.email,
      role: Role.USER,
      tokenType: TOKEN_TYPES.refresh,
    });

    for (const token of [undefined, 'not-a-token', expired, refresh]) {
      const response = await post(
        '/credits/consume',
        { amount: 10, idempotencyKey: `http-5-${token ?? 'none'}` },
        token,
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    }

    expect(await prisma.creditTransaction.count({ where: { walletId } })).toBe(0);

    const reversed = await post('/credits/reverse', { idempotencyKey: 'http-5' });
    expect(reversed.status).toBe(401);

    const allowed = await post(
      '/credits/consume',
      { amount: 10, idempotencyKey: 'http-6' },
      accessToken,
    );
    expect(allowed.status).toBe(200);
  });

  it('refuses a body that tries to name a user, and a malformed amount', async () => {
    const caller = await aFundedCaller();
    const other = await aFundedCaller();

    const named = await post(
      '/credits/consume',
      { amount: 10, idempotencyKey: 'http-7', userId: other.userId },
      caller.accessToken,
    );

    expect(named.status).toBe(400);
    expect(await named.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(
      await prisma.creditWallet.findUniqueOrThrow({ where: { id: other.walletId } }),
    ).toMatchObject({ subscriptionCredits: 100 });

    for (const amount of [0, -10, 1.5]) {
      const response = await post(
        '/credits/consume',
        { amount, idempotencyKey: `http-8-${amount}` },
        caller.accessToken,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('adjusts the wallet named in the path for an admin, and nobody else', async () => {
    const subject = await aFundedCaller();
    const admin = await anAdminToken();

    const adjusted = await post(
      `/admin/users/${subject.userId}/credits/adjust`,
      { amount: 25, reason: 'support goodwill' },
      admin,
    );

    expect(adjusted.status).toBe(200);
    expect(await adjusted.json()).toEqual({ subscription: 100, addon: 75 });
    expect(
      await prisma.creditWallet.findUniqueOrThrow({ where: { id: subject.walletId } }),
    ).toMatchObject({ subscriptionCredits: 100, addonCredits: 75 });

    const asUser = await post(
      `/admin/users/${subject.userId}/credits/adjust`,
      { amount: 25, reason: 'self service' },
      subject.accessToken,
    );

    expect(asUser.status).toBe(403);
    expect(await asUser.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const anonymous = await post(`/admin/users/${subject.userId}/credits/adjust`, {
      amount: 25,
      reason: 'no token',
    });

    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });

    expect(
      await prisma.creditWallet.findUniqueOrThrow({ where: { id: subject.walletId } }),
    ).toMatchObject({ addonCredits: 75 });

    const walletless = await post(
      `/admin/users/${await aCallerWithoutAWallet()}/credits/adjust`,
      { amount: 25, reason: 'no wallet' },
      admin,
    );

    expect(walletless.status).toBe(404);
    expect(await walletless.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('refuses a malformed adjustment, a named ledger, and a debit the wallet cannot cover', async () => {
    const subject = await aFundedCaller();
    const admin = await anAdminToken();
    const path = `/admin/users/${subject.userId}/credits/adjust`;

    for (const body of [
      { amount: 0, reason: 'nothing' },
      { amount: 1.5, reason: 'a fraction' },
      { amount: 25, reason: 'a ledger', ledger: 'SUBSCRIPTION' },
      { amount: 25 },
      { amount: 25, reason: '' },
    ]) {
      const response = await post(path, body, admin);

      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }

    const overLarge = await post(path, { amount: -80, reason: 'clawback' }, admin);

    expect(overLarge.status).toBe(400);
    expect(await overLarge.json()).toMatchObject({
      error: { code: 'ADJUSTMENT_EXCEEDS_BALANCE' },
    });
    expect(
      await prisma.creditWallet.findUniqueOrThrow({ where: { id: subject.walletId } }),
    ).toMatchObject({ subscriptionCredits: 100, addonCredits: 50 });
  });
});
