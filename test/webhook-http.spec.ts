import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { WebhookStatus } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthModule } from '../src/auth/auth.module';
import { FakeStripeAdapter } from '../src/billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../src/billing/stripe/interfaces/stripe-adapter.interface';
import { STRIPE_API_VERSION } from '../src/billing/stripe/stripe.constants';
import { signTestPayload } from '../src/billing/stripe/webhook-signature';
import { CustomerCreatedHandler } from '../src/billing/webhook/handlers/customer-created.handler';
import {
  Resolution,
  WebhookHandler,
  WebhookOutcome,
} from '../src/billing/webhook/handlers/webhook-handler.interface';
import {
  OUTCOME_STATUSES,
  RESOLVED,
  STRIPE_SIGNATURE_HEADER,
  WEBHOOK_EVENT_TYPES,
} from '../src/billing/webhook/webhook.constants';
import { WebhookModule } from '../src/billing/webhook/webhook.module';
import { Clock } from '../src/common/clock/clock';
import { AppConfigModule } from '../src/common/config/config.module';
import { configurations } from '../src/common/config/configuration';
import { DomainExceptionFilter } from '../src/common/errors/domain-exception.filter';
import { MetricsModule } from '../src/common/metrics/metrics.module';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

const DASHBOARD_SECRET = 'whsec_dashboard_secret_for_tests';
const CLI_SECRET = 'whsec_cli_secret_for_tests';
const UNSUBSCRIBED_TYPE = 'radar.early_fraud_warning.created';

process.env.STRIPE_WEBHOOK_SECRET = `${DASHBOARD_SECRET},${CLI_SECRET}`;

class ProgrammableHandler extends WebhookHandler {
  readonly eventType = WEBHOOK_EVENT_TYPES.customerCreated;

  calls = 0;
  outcome: WebhookOutcome = { status: OUTCOME_STATUSES.completed };

  resolve(): Promise<Resolution> {
    this.calls += 1;

    if (this.outcome.status !== OUTCOME_STATUSES.completed) {
      return Promise.resolve(this.outcome);
    }

    return Promise.resolve({ status: RESOLVED, apply: () => Promise.resolve(this.outcome) });
  }
}

describe('the Stripe webhook endpoint', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  const handler = new ProgrammableHandler();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        MetricsModule,
        AuthModule,
        WebhookModule,
      ],
    })
      .overrideProvider(StripeService)
      .useFactory({ factory: (clock: Clock) => new FakeStripeAdapter(clock), inject: [Clock] })
      .overrideProvider(CustomerCreatedHandler)
      .useValue(handler)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
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

  beforeEach(() => {
    handler.calls = 0;
    handler.outcome = { status: OUTCOME_STATUSES.completed };
  });

  function anEvent(type: string = WEBHOOK_EVENT_TYPES.customerCreated): string {
    return JSON.stringify({
      id: `evt_${crypto.randomUUID().replace(/-/g, '')}`,
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: Math.floor(Date.now() / 1000),
      type,
      data: { object: { id: `sub_${crypto.randomUUID().replace(/-/g, '')}`, object: 'subscription' } },
    });
  }

  function idOf(payload: string): string {
    return (JSON.parse(payload) as { id: string }).id;
  }

  function deliver(payload: string, secret = DASHBOARD_SECRET): Promise<Response> {
    return fetch(`${baseUrl}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [STRIPE_SIGNATURE_HEADER]: signTestPayload(payload, secret, new Date()),
      },
      body: payload,
    });
  }

  function rowsFor(payload: string) {
    return prisma.webhookEvent.findMany({ where: { stripeEventId: idOf(payload) } });
  }

  it('rejects a forged signature, persists nothing, and accepts the second configured secret', async () => {
    const forged = anEvent();
    const rejected = await deliver(forged, 'whsec_not_configured');

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await rowsFor(forged)).toEqual([]);
    expect(handler.calls).toBe(0);

    const signedWithCli = anEvent();
    const accepted = await deliver(signedWithCli, CLI_SECRET);

    expect(accepted.status).toBe(200);
    expect(await rowsFor(signedWithCli)).toHaveLength(1);
  });

  it('skips a redelivered completed event and leaves exactly one row', async () => {
    const payload = anEvent();

    expect((await deliver(payload)).status).toBe(200);
    expect(handler.calls).toBe(1);

    const redelivered = await deliver(payload);

    expect(redelivered.status).toBe(200);
    expect(handler.calls).toBe(1);
    expect(await rowsFor(payload)).toMatchObject([{ status: WebhookStatus.COMPLETED }]);

    await expect(
      prisma.webhookEvent.create({
        data: { stripeEventId: idOf(payload), type: UNSUBSCRIBED_TYPE, payload: {} },
      }),
    ).rejects.toThrow();
    expect(await rowsFor(payload)).toHaveLength(1);
  });

  it('processes a redelivered failed event again', async () => {
    const payload = anEvent();
    handler.outcome = { status: OUTCOME_STATUSES.failed, detail: 'the first attempt broke' };

    const failed = await deliver(payload);

    expect(failed.status).not.toBe(200);
    expect(await rowsFor(payload)).toMatchObject([{ status: WebhookStatus.FAILED }]);

    handler.outcome = { status: OUTCOME_STATUSES.completed };
    const retried = await deliver(payload);

    expect(retried.status).toBe(200);
    expect(handler.calls).toBe(2);
    expect(await rowsFor(payload)).toMatchObject([
      { status: WebhookStatus.COMPLETED, failureReason: null },
    ]);
  });

  it('answers non-2xx and records the reason when a handler fails', async () => {
    const payload = anEvent();
    handler.outcome = { status: OUTCOME_STATUSES.failed, detail: 'the plan row was malformed' };

    const response = await deliver(payload);
    const [row] = await rowsFor(payload);

    expect(response.status).not.toBe(200);
    expect(row).toMatchObject({ status: WebhookStatus.FAILED });
    expect(row.failureReason).toContain('the plan row was malformed');
    expect(row.processedAt).not.toBeNull();
  });

  it('records a deferral distinguishably from a failure', async () => {
    const deferredPayload = anEvent();
    handler.outcome = { status: OUTCOME_STATUSES.deferred, detail: 'no local subscription yet' };

    const deferred = await deliver(deferredPayload);
    const [deferredRow] = await rowsFor(deferredPayload);

    expect(deferred.status).not.toBe(200);
    expect(deferredRow.failureReason?.startsWith(OUTCOME_STATUSES.deferred)).toBe(true);

    const failedPayload = anEvent();
    handler.outcome = { status: OUTCOME_STATUSES.failed, detail: 'no local subscription yet' };
    await deliver(failedPayload);
    const [failedRow] = await rowsFor(failedPayload);

    expect(failedRow.failureReason?.startsWith(OUTCOME_STATUSES.failed)).toBe(true);
    expect(deferredRow.failureReason).not.toBe(failedRow.failureReason);
  });

  it('dispatches by type and completes an unsubscribed type without work', async () => {
    const claimed = anEvent();

    expect((await deliver(claimed)).status).toBe(200);
    expect(handler.calls).toBe(1);

    const unsubscribed = anEvent(UNSUBSCRIBED_TYPE);
    const response = await deliver(unsubscribed);

    expect(response.status).toBe(200);
    expect(handler.calls).toBe(1);
    expect(await rowsFor(unsubscribed)).toMatchObject([
      { status: WebhookStatus.COMPLETED, failureReason: null },
    ]);
  });
});
