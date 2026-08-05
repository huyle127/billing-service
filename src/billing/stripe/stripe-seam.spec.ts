import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../common/clock/clock';
import { FixedClock } from '../../common/clock/fixed-clock';
import { AppConfigService } from '../../common/config/app-config.service';
import { FAKE_WEBHOOK_SECRET, FakeStripeAdapter } from './adapters/fake-stripe.adapter';
import { StripeSdkAdapter } from './adapters/stripe-sdk.adapter';
import { StripeAdapterError } from './stripe.error';
import { StripeService } from './interfaces/stripe-adapter.interface';
import {
  BILLING_MODES,
  IDEMPOTENCY_KEYS,
  METADATA_KEYS,
  metadataQuery,
  STRIPE_API_VERSION,
  STRIPE_OPERATIONS,
} from './stripe.constants';
import { signTestPayload } from './webhook-signature';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const OTHER_SECRET = 'whsec_rotated_secret';

const OPERATIONS = Object.values(STRIPE_OPERATIONS);

@Injectable()
class Provisioner {
  constructor(private readonly stripe: StripeService) {}

  async provision(userId: string): Promise<string> {
    const customer = await this.stripe.createCustomer({
      userId,
      email: `${userId}@example.com`,
    });

    return customer.id;
  }
}

describe('the Stripe seam', () => {
  let clock: FixedClock;

  beforeEach(() => {
    clock = new FixedClock(NOW);
  });

  it('pins the API version rather than inheriting the account default', () => {
    const config = {
      stripeSecretKey: 'sk_test_x',
      stripeWebhookSecrets: [],
    } as unknown as AppConfigService;
    const adapter = new StripeSdkAdapter(config, clock);

    expect(STRIPE_API_VERSION).toBe('2026-07-29.dahlia');
    expect(adapter.apiVersion).toBe(STRIPE_API_VERSION);
    expect(new Stripe('sk_test_x', { apiVersion: STRIPE_API_VERSION }).getApiField('version')).toBe(
      STRIPE_API_VERSION,
    );
  });

  it('lets a test swap the implementation without touching the caller', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        Provisioner,
        { provide: Clock, useValue: clock },
        { provide: StripeService, useFactory: () => new FakeStripeAdapter(clock) },
      ],
    }).compile();

    const customerId = await moduleRef.get(Provisioner).provision('user_1');
    const stripe = moduleRef.get<StripeService>(StripeService);

    expect(customerId).toMatch(/^cus_fake_/);
    expect(await stripe.findCustomerByUserId('user_1')).not.toBeNull();
  });

  it('answers every declared operation from both adapters', async () => {
    const fake = new FakeStripeAdapter(clock) as unknown as Record<string, unknown>;
    const sdk = StripeSdkAdapter.prototype as unknown as Record<string, unknown>;

    for (const operation of OPERATIONS) {
      expect(typeof fake[operation]).toBe('function');
      expect(typeof sdk[operation]).toBe('function');
    }
  });

  it('exposes no operation that lists the Stripe catalog', () => {
    const names = [
      ...Object.getOwnPropertyNames(StripeSdkAdapter.prototype),
      ...Object.getOwnPropertyNames(FakeStripeAdapter.prototype),
    ];

    expect(names.filter((name) => /^list/.test(name))).toEqual([]);
  });

  it('keeps the SDK inside the adapter directory', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src'))
      .filter((file) => !relative(process.cwd(), file).includes(join('billing', 'stripe')))
      .filter((file) => /from '(stripe|stripe\/.*)'/.test(readFileSync(file, 'utf8')));

    expect(offenders.map((file) => relative(process.cwd(), file))).toEqual([]);
  });
});

describe('what the SDK adapter actually sends', () => {
  let clock: FixedClock;

  beforeEach(() => {
    clock = new FixedClock(NOW);
  });

  function stubbed() {
    const config = {
      stripeSecretKey: 'sk_test_x',
      stripeWebhookSecrets: [],
    } as unknown as AppConfigService;
    const adapter = new StripeSdkAdapter(config, clock);
    const client = (adapter as unknown as { client: Stripe }).client;
    const sent: { params: Record<string, unknown>; options: { idempotencyKey?: string } }[] = [];

    const record = (id: string) => (params: unknown, options: unknown) => {
      sent.push({
        params: params as Record<string, unknown>,
        options: options as { idempotencyKey?: string },
      });

      return Promise.resolve({
        id,
        metadata: (params as { metadata?: unknown }).metadata ?? {},
        items: { data: [] },
        billing_mode: { type: BILLING_MODES.flexible },
        cancel_at_period_end: false,
        invoice_settings: {},
      });
    };

    client.customers.create = record('cus_1') as unknown as typeof client.customers.create;
    client.subscriptions.create = record('sub_1') as unknown as typeof client.subscriptions.create;

    return { adapter, sent };
  }

  it('derives the idempotency key from our own identifier, not from a caller', async () => {
    const { adapter, sent } = stubbed();

    await adapter.createCustomer({ userId: 'user_1', email: 'a@example.com' });
    await adapter.createSubscription({
      subscriptionId: 'sub_local_1',
      userId: 'user_1',
      customerId: 'cus_1',
      priceId: 'price_1',
    });

    expect(sent[0].options.idempotencyKey).toBe(IDEMPOTENCY_KEYS.customer('user_1'));
    expect(sent[1].options.idempotencyKey).toBe(IDEMPOTENCY_KEYS.subscription('sub_local_1'));
  });

  it('tags every created object with the identifiers that make it traceable', async () => {
    const { adapter, sent } = stubbed();

    await adapter.createCustomer({ userId: 'user_1', email: 'a@example.com' });
    await adapter.createSubscription({
      subscriptionId: 'sub_local_1',
      userId: 'user_1',
      customerId: 'cus_1',
      priceId: 'price_1',
    });

    expect(sent[0].params.metadata).toEqual({ [METADATA_KEYS.userId]: 'user_1' });
    expect(sent[1].params.metadata).toEqual({
      [METADATA_KEYS.userId]: 'user_1',
      [METADATA_KEYS.subscriptionId]: 'sub_local_1',
    });
  });

  it('searches by the same metadata key it writes', () => {
    expect(metadataQuery('userId', 'user_1')).toBe(`metadata['${METADATA_KEYS.userId}']:'user_1'`);
    expect(metadataQuery('subscriptionId', 'sub_local_1')).toBe(
      `metadata['${METADATA_KEYS.subscriptionId}']:'sub_local_1'`,
    );
  });

  it('builds no idempotency key or metadata key from a literal', () => {
    const seam = sourceFiles(join(process.cwd(), 'src', 'billing', 'stripe')).filter(
      (file) => !file.endsWith('stripe.constants.ts') && !file.endsWith('.spec.ts'),
    );

    for (const file of seam) {
      const source = readFileSync(file, 'utf8');

      expect({ file: relative(process.cwd(), file), hits: source.match(/idempotencyKey: `/g) })
        .toEqual({ file: relative(process.cwd(), file), hits: null });
      expect({ file: relative(process.cwd(), file), hits: source.match(/metadata\['/g) }).toEqual({
        file: relative(process.cwd(), file),
        hits: null,
      });
    }
  });
});

describe('webhook event construction', () => {
  let clock: FixedClock;
  let stripe: FakeStripeAdapter;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    stripe = new FakeStripeAdapter(clock, [OTHER_SECRET, FAKE_WEBHOOK_SECRET]);
  });

  function signedEvent(secret: string) {
    const payload = stripe.buildEventPayload('customer.subscription.created', {
      id: 'sub_123',
      object: 'subscription',
    });

    return stripe.signPayloadWith(payload, secret);
  }

  it('accepts a payload signed with any configured secret', () => {
    const { rawBody, signature } = signedEvent(FAKE_WEBHOOK_SECRET);

    const event = stripe.constructWebhookEvent(rawBody, signature);

    expect(event.type).toBe('customer.subscription.created');
    expect(event.objectId).toBe('sub_123');
    expect(event.apiVersion).toBe(STRIPE_API_VERSION);
    expect(event.createdAt).toEqual(NOW);
  });

  it('reports an event rendered under another API version instead of swallowing it', () => {
    const config = {
      stripeSecretKey: 'sk_test_x',
      stripeWebhookSecrets: [FAKE_WEBHOOK_SECRET],
    } as unknown as AppConfigService;
    const adapter = new StripeSdkAdapter(config, clock);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const payload = {
      ...stripe.buildEventPayload('invoice.paid', { id: 'in_1', object: 'invoice' }),
      api_version: '2025-03-31.basil',
    };
    const { rawBody, signature } = stripe.signPayloadWith(payload, FAKE_WEBHOOK_SECRET);

    const event = adapter.constructWebhookEvent(rawBody, signature);

    expect(event.apiVersion).toBe('2025-03-31.basil');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(STRIPE_API_VERSION);

    warn.mockRestore();
  });

  it('rejects a payload signed with an unknown secret', () => {
    const { rawBody, signature } = signedEvent('whsec_not_configured');

    expect(() => stripe.constructWebhookEvent(rawBody, signature)).toThrow(StripeAdapterError);

    const thrown = catchError(() => stripe.constructWebhookEvent(rawBody, signature));
    expect(thrown?.verdict).toBe('permanent');
    expect(thrown?.stripeErrorType).toBe('StripeSignatureVerificationError');
  });

  it('rejects a body altered after it was signed', () => {
    const { rawBody, signature } = signedEvent(FAKE_WEBHOOK_SECRET);
    const tampered = Buffer.from(rawBody.toString('utf8').replace('sub_123', 'sub_evil'), 'utf8');

    const thrown = catchError(() => stripe.constructWebhookEvent(tampered, signature));

    expect(thrown?.stripeErrorType).toBe('StripeSignatureVerificationError');
  });

  it('measures the signature timestamp against the injected clock', () => {
    const payload = stripe.buildEventPayload('invoice.paid', { id: 'in_1', object: 'invoice' });
    const body = JSON.stringify(payload);
    const staleSignature = signTestPayload(body, FAKE_WEBHOOK_SECRET, NOW);

    clock.advance(3600 * 1000);

    const thrown = catchError(() =>
      stripe.constructWebhookEvent(Buffer.from(body, 'utf8'), staleSignature),
    );

    expect(thrown?.verdict).toBe('permanent');
  });
});

function catchError(run: () => unknown): StripeAdapterError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as StripeAdapterError;
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith('.ts') ? [path] : [];
  });
}
