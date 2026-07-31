import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, CORS_ORIGINS, configureApp } from '../../src/app.setup';
import { RATE_LIMITING_ENABLED } from '../../src/common/throttling/throttling.module';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import { FakeBillingProvider } from '../../src/provider/testing/fake-billing.provider';
import { testDatabase } from './test-database';

/**
 * Building the whole HTTP stack — global guard, validation pipe, error filter,
 * raw-bodied webhook route — is what makes an API test assert the contract a
 * client actually meets rather than what a service method returns. Every
 * endpoint suite needs the same one, so it is assembled here once.
 */

/** Stand-in Stripe Price identifiers; the fake provider never resolves them. */
export const PRICE_IDS: Record<string, string> = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

export const CHECKOUT_URLS = {
  successUrl: 'https://test.local/success',
  cancelUrl: 'https://test.local/cancel',
};

export interface RegisteredUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
}

export interface ApiHarnessOptions {
  /**
   * Whether the request rate ceiling is enforced. Off by default, and that is
   * a deliberate, narrow exception rather than a convenience.
   *
   * These suites register a user per test case, all from one address, so the
   * production auth tier of five a minute is exhausted a few tests into any
   * file. Left on, every suite would become a rate-limit test and would fail
   * for a reason unrelated to what it asserts. The suite that *is* about rate
   * limiting turns this on and asserts the real, unmodified tiers.
   */
  rateLimiting?: boolean;
  /** Origins the cross-origin policy permits. Empty permits none. */
  corsOrigins?: string[];
}

/**
 * The application under test, with the provider faked and nothing else
 * substituted — the guard, the filter, and the pipes are the production ones.
 */
export class ApiHarness {
  readonly provider = new FakeBillingProvider();
  private application?: NestExpressApplication;
  private restoreEnvironment: (() => void)[] = [];

  constructor(private readonly options: ApiHarnessOptions = {}) {}

  get app(): NestExpressApplication {
    if (!this.application) {
      throw new Error('ApiHarness.start() has not been awaited.');
    }
    return this.application;
  }

  /** Nest types this `any`; supertest takes it as the app under test. */
  get server(): ReturnType<NestExpressApplication['getHttpServer']> {
    return this.app.getHttpServer();
  }

  async start(): Promise<void> {
    // Set before the module is compiled: both are read by factories that run
    // during compilation, so assigning them afterwards would have no effect.
    this.setEnvironment(
      RATE_LIMITING_ENABLED,
      this.options.rateLimiting ? 'true' : 'false',
    );
    if (this.options.corsOrigins) {
      this.setEnvironment(CORS_ORIGINS, this.options.corsOrigins.join(','));
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BILLING_PROVIDER)
      .useValue(this.provider)
      .compile();

    this.application =
      moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    configureApp(this.application);
    await this.application.init();
  }

  async stop(): Promise<void> {
    await this.application?.close();
    this.application = undefined;
    for (const restore of this.restoreEnvironment.reverse()) {
      restore();
    }
    this.restoreEnvironment = [];
  }

  private setEnvironment(name: string, value: string): void {
    const previous = process.env[name];
    this.restoreEnvironment.push(() => {
      if (previous === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous;
      }
    });
    process.env[name] = value;
  }

  /** Seeds the catalog and returns the AI product's id. */
  async seedCatalog(): Promise<string> {
    const seeded = await seedCatalog(testDatabase.prisma, PRICE_IDS);
    return seeded.productId;
  }

  /**
   * Registers a user over HTTP, so the token under test is one the service
   * actually issued rather than one the test signed for itself.
   */
  async register(
    email = `${randomUUID()}@test.local`,
    password = 'test-password',
  ): Promise<RegisteredUser> {
    const response = await request(this.server)
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    const body = response.body as {
      user: { id: string; email: string };
      accessToken: string;
    };

    return {
      id: body.user.id,
      email: body.user.email,
      password,
      accessToken: body.accessToken,
    };
  }

  /** An authenticated GET, the shape most read assertions need. */
  get(path: string, user: RegisteredUser) {
    return request(this.server)
      .get(path)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  post(path: string, user: RegisteredUser) {
    return request(this.server)
      .post(path)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  patch(path: string, user: RegisteredUser) {
    return request(this.server)
      .patch(path)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }

  delete(path: string, user: RegisteredUser) {
    return request(this.server)
      .delete(path)
      .set('Authorization', `Bearer ${user.accessToken}`);
  }
}
