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
const PRO = { planCode: 'pro', cycle: 'MONTHLY' };

describe('the /v1/me surface', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let stripe: FakeStripeAdapter;

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
    stripe = moduleRef.get(StripeService) as unknown as FakeStripeAdapter;
  });

  afterAll(async () => {
    await app.close();
  });

  function call(method: string, path: string, token?: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function aUser(): Promise<{ token: string; userId: string }> {
    const email = `${crypto.randomUUID()}@example.test`;
    await call('POST', '/auth/register', undefined, { email, password: PASSWORD });
    const login = await call('POST', '/auth/login', undefined, { email, password: PASSWORD });
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });

    return { token: ((await login.json()) as { accessToken: string }).accessToken, userId: id };
  }

  async function aProSubscriber(): Promise<{ token: string; userId: string; id: string }> {
    const { token, userId } = await aUser();
    await call('POST', '/me/subscription', token, PRO);
    const pending = await prisma.subscription.findFirstOrThrow({
      where: { userId, status: 'PENDING' },
    });

    await prisma.subscription.update({
      where: { id: (await prisma.subscription.findFirstOrThrow({
        where: { userId, status: 'ACTIVE' },
      })).id },
      data: { status: 'EXPIRED' },
    });
    await prisma.subscription.update({ where: { id: pending.id }, data: { status: 'ACTIVE' } });

    return { token, userId, id: pending.id };
  }

  it('serves the dashboard from the database alone and refuses a body naming a user', async () => {
    const { token, userId } = await aUser();

    await prisma.billingCustomer.update({
      where: { userId },
      data: { stripeCustomerId: null },
    });

    const subscription = await call('GET', '/me/subscription', token);
    const wallet = await call('GET', '/me/wallet', token);

    expect(subscription.status).toBe(200);
    expect(await subscription.json()).toMatchObject({
      current: { planCode: 'free', status: 'ACTIVE', monthlyCredits: 50 },
      awaitingPayment: null,
    });
    expect(wallet.status).toBe(200);
    expect(await wallet.json()).toMatchObject({
      status: 'ACTIVE',
      balance: { subscription: 50, addon: 0 },
    });

    const impersonating = await call('POST', '/me/subscription', token, {
      ...PRO,
      userId: crypto.randomUUID(),
    });
    expect(impersonating.status).toBe(400);
  });

  it('leaves the subscriber on Free while the paid subscription waits for payment', async () => {
    const { token, userId } = await aUser();

    const response = await call('POST', '/me/subscription', token, PRO);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      current: { planCode: 'free', status: 'ACTIVE' },
      awaitingPayment: { planCode: 'pro', status: 'PENDING' },
    });
    expect(await prisma.creditWallet.findUniqueOrThrow({ where: { userId } })).toMatchObject({
      subscriptionCredits: 50,
    });
  });

  it('prorates an upgrade at once and holds a downgrade until renewal', async () => {
    const { token, userId, id } = await aProSubscriber();

    const annual = await call('PATCH', '/me/subscription', token, {
      planCode: 'pro',
      cycle: 'ANNUAL',
    });

    expect(annual.status).toBe(200);
    expect(stripe.lastSubscriptionUpdate()).toMatchObject({
      prorationBehavior: 'create_prorations',
    });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id } })).toMatchObject({
      cycle: 'ANNUAL',
      pendingPlanId: null,
    });

    const back = await call('PATCH', '/me/subscription', token, PRO);
    const monthly = await prisma.plan.findFirstOrThrow({
      where: { code: 'pro', cycle: 'MONTHLY' },
    });

    expect(back.status).toBe(200);
    expect(stripe.lastSubscriptionUpdate()).toMatchObject({ prorationBehavior: 'none' });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id } })).toMatchObject({
      cycle: 'ANNUAL',
      pendingPlanId: monthly.id,
      pendingCycle: 'MONTHLY',
    });
    expect(await prisma.subscription.count({ where: { userId, status: 'ACTIVE' } })).toBe(1);
  });

  it('cancels a paid plan and resumes it, and refuses to cancel Free at all', async () => {
    const { token, id } = await aProSubscriber();

    const canceled = await call('DELETE', '/me/subscription', token);

    expect(canceled.status).toBe(200);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'CANCELED',
    });

    const resumed = await call('POST', '/me/subscription', token, PRO);

    expect(resumed.status).toBe(201);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'ACTIVE',
      canceledAt: null,
    });
    expect(
      await prisma.subscriptionEvent.findMany({ where: { subscriptionId: id, type: 'RESUMED' } }),
    ).toHaveLength(1);

    const free = await aUser();
    expect((await call('DELETE', '/me/subscription', free.token)).status).toBe(400);
  });

  it('refuses to detach the last card while a paid subscription runs, and stores no card data', async () => {
    const { token, userId } = await aProSubscriber();

    const attached = await call('POST', '/me/payment-methods', token, {
      paymentMethodId: `pm_${crypto.randomUUID()}`,
    });
    const method = (await attached.json()) as { id: string; last4: string };

    expect(attached.status).toBe(201);
    expect(method).toMatchObject({ brand: 'visa', last4: '4242', isDefault: true });

    const refused = await call('DELETE', `/me/payment-methods/${method.id}`, token);

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { code: 'PAYMENT_METHOD_REQUIRED' },
    });
    expect(await prisma.paymentMethod.count({ where: { userId, detachedAt: null } })).toBe(1);

    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT "column_name" FROM "information_schema"."columns"
      WHERE "table_name" = 'PaymentMethod'
    `;
    expect(columns.map((row) => row.column_name).sort()).toEqual([
      'brand',
      'createdAt',
      'detachedAt',
      'expMonth',
      'expYear',
      'id',
      'isDefault',
      'last4',
      'stripePaymentMethodId',
      'userId',
    ]);
  });
});
