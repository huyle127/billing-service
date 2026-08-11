import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_TYPES } from '@/auth/auth.constants';
import { AuthModule } from '@/auth/auth.module';
import { BillingModule } from '@/billing/billing.module';
import { FakeStripeAdapter } from '@/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '@/billing/stripe/interfaces/stripe-adapter.interface';
import { Clock } from '@/common/clock/clock';
import { AppConfigService } from '@/common/config/app-config.service';
import { AppConfigModule } from '@/common/config/config.module';
import { configurations } from '@/common/config/configuration';
import { DomainExceptionFilter } from '@/common/errors/domain-exception.filter';
import { INTERNAL_KEY_HEADER } from '@/common/identity/internal-key.guard';
import { MetricsModule } from '@/common/metrics/metrics.module';
import { PrismaModule } from '@/common/prisma/prisma.module';

const ALLOCATIONS = 'internal/allocations/run';
const PROVISIONING = 'internal/provisioning/run';

describe('the internal endpoints', () => {
  let app: INestApplication;
  let baseUrl: string;
  let internalKey: string;
  let userToken: string;

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
      .useFactory({ factory: (at: Clock) => new FakeStripeAdapter(at), inject: [Clock] })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    baseUrl = await app.getUrl();
    internalKey = moduleRef.get(AppConfigService).internalApiKey;
    userToken = moduleRef.get(JwtService).sign({
      sub: crypto.randomUUID(),
      email: 'someone@example.test',
      role: Role.USER,
      tokenType: TOKEN_TYPES.access,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function run(path: string, headers: Record<string, string>, body: unknown = {}) {
    return fetch(`${baseUrl}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  it('opens only for the internal key, and not for a user token', async () => {
    const withKey = { [INTERNAL_KEY_HEADER]: internalKey };

    expect((await run(ALLOCATIONS, {})).status).toBe(401);
    expect((await run(ALLOCATIONS, { [INTERNAL_KEY_HEADER]: 'not-the-key' })).status).toBe(401);
    expect((await run(ALLOCATIONS, { authorization: `Bearer ${userToken}` })).status).toBe(401);

    const admitted = await run(ALLOCATIONS, withKey);

    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ subscriptions: 0, grants: 0 });

    const provisioning = await run(PROVISIONING, withKey);

    expect(provisioning.status).toBe(200);
    expect(await provisioning.json()).toEqual({ subscriptions: 0 });
  });

  it('refuses a request naming a user to act for, rather than ignoring it', async () => {
    const response = await run(
      ALLOCATIONS,
      { [INTERNAL_KEY_HEADER]: internalKey },
      { userId: crypto.randomUUID() },
    );

    expect(response.status).toBe(400);
  });
});
