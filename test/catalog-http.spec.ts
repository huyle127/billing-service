import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BillingCycle, Plan } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmin } from '../prisma/seed-admin';
import { AuthModule } from '../src/auth/auth.module';
import { BillingModule } from '../src/billing/billing.module';
import { FakeStripeAdapter } from '../src/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../src/billing/stripe/interfaces/stripe-adapter.interface';
import { Clock } from '../src/common/clock/clock';
import { AppConfigModule } from '../src/common/config/config.module';
import { configurations } from '../src/common/config/configuration';
import { DomainExceptionFilter } from '../src/common/errors/domain-exception.filter';
import { MetricsModule } from '../src/common/metrics/metrics.module';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

const PASSWORD = 'correct horse battery staple';
const DRAFT = 'plan_http_';

describe('the catalog over HTTP', () => {
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

    await dropDrafts();
  });

  afterAll(async () => {
    await dropDrafts();
    await app.close();
  });

  async function dropDrafts(): Promise<void> {
    await prisma.subscription.deleteMany({ where: { plan: { code: { startsWith: DRAFT } } } });
    await prisma.plan.deleteMany({ where: { code: { startsWith: DRAFT } } });
  }

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

  async function anAdminToken(): Promise<string> {
    await seedAdmin(prisma);
    const login = await call('POST', '/auth/login', undefined, {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });

    return ((await login.json()) as { accessToken: string }).accessToken;
  }

  async function aUser(): Promise<{ accessToken: string; userId: string }> {
    const email = `${crypto.randomUUID()}@example.test`;
    await call('POST', '/auth/register', undefined, { email, password: PASSWORD });
    const login = await call('POST', '/auth/login', undefined, { email, password: PASSWORD });
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });

    return { accessToken: ((await login.json()) as { accessToken: string }).accessToken, userId: id };
  }

  function aPlanDraft() {
    return {
      code: `${DRAFT}${crypto.randomUUID().slice(0, 8)}`,
      name: 'Team',
      cycle: BillingCycle.MONTHLY,
      monthlyCredits: 300,
      amountCents: 3000,
    };
  }

  it('lists the local catalog and never the products living in the Stripe account', async () => {
    await stripe.createProduct({ code: 'myproduct', name: 'myproduct' });
    const stray = await stripe.createPrice({
      code: 'myproduct',
      productId: (await stripe.createProduct({ code: 'dahlia', name: 'Dahlia Verify Pro' })).id,
      unitAmount: 999,
      currency: 'usd',
      interval: 'month',
    });

    const response = await call('GET', '/plans');
    const plans = (await response.json()) as Plan[];
    const seeded = await prisma.plan.findMany({ where: { active: true } });

    expect(response.status).toBe(200);
    expect(plans.map((plan) => plan.code).sort()).toEqual(seeded.map((plan) => plan.code).sort());
    expect(plans.some((plan) => plan.stripePriceId === stray.id)).toBe(false);
  });

  it('archives an unused plan in both systems, and refuses a caller without the admin role', async () => {
    const adminToken = await anAdminToken();
    const created = await call('POST', '/admin/plans', adminToken, aPlanDraft());
    const plan = (await created.json()) as Plan;

    const { accessToken } = await aUser();

    expect(created.status).toBe(201);
    expect(await call('DELETE', `/admin/plans/${plan.id}`, accessToken)).toMatchObject({
      status: 403,
    });

    const archived = await call('DELETE', `/admin/plans/${plan.id}`, adminToken);
    expect(archived.status).toBe(200);

    const [price] = await stripe.findPricesByPlanCode(plan.code);
    expect(price.active).toBe(false);

    const listed = (await (await call('GET', '/plans')).json()) as Plan[];
    expect(listed.some((row) => row.id === plan.id)).toBe(false);
  });

  it('shows one user their billing state to an admin, and to nobody else', async () => {
    const { accessToken, userId } = await aUser();

    expect(await call('GET', `/admin/users/${userId}/billing`, accessToken)).toMatchObject({
      status: 403,
    });

    const seen = await call('GET', `/admin/users/${userId}/billing`, await anAdminToken());

    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({
      userId,
      subscription: { planCode: 'free', status: 'ACTIVE' },
      balances: { subscription: 50, addon: 0 },
    });
  });
});
