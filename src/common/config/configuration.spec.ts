import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from './app-config.service';
import { configurations, provisioningConfig, stripeConfig } from './configuration';

describe('configuration', () => {
  let original: NodeJS.ProcessEnv;

  beforeEach(() => {
    original = { ...process.env };
  });

  afterEach(() => {
    process.env = original;
  });

  it('fails and names the value when a required key is absent', () => {
    delete process.env.STRIPE_SECRET_KEY;

    expect(() => stripeConfig()).toThrowError('Missing required configuration: STRIPE_SECRET_KEY');
  });

  it('refuses a malformed integer rather than coercing it', async () => {
    process.env.WEBHOOK_BATCH_SIZE = 'ten';

    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, load: configurations })],
      }).compile(),
    ).rejects.toThrowError('WEBHOOK_BATCH_SIZE must be a non-negative integer');
  });

  it('refuses a negative value rather than reading it as a disabled feature', () => {
    process.env.PROVISIONING_BATCH_SIZE = '-1';

    expect(() => provisioningConfig()).toThrowError(
      'PROVISIONING_BATCH_SIZE must be a non-negative integer',
    );
  });

  it('takes a zero sweep interval as itself, not as an absent value falling back to the default', () => {
    process.env.PROVISIONING_SWEEP_INTERVAL_MS = '0';

    expect(provisioningConfig().sweepIntervalMs).toBe(0);
  });

  it('reads more than one webhook signing secret', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dashboard, whsec_cli ,';

    expect(stripeConfig().webhookSecrets).toEqual(['whsec_dashboard', 'whsec_cli']);
  });

  it('resolves every accessor, so a mistyped configuration path cannot reach production', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: configurations })],
      providers: [AppConfigService],
    }).compile();

    const config = moduleRef.get(AppConfigService);
    const accessors = Object.getOwnPropertyNames(AppConfigService.prototype).filter(
      (name) => name !== 'constructor',
    );

    expect(accessors.length).toBeGreaterThan(0);
    for (const accessor of accessors) {
      expect(() => config[accessor as keyof AppConfigService], accessor).not.toThrow();
      expect(config[accessor as keyof AppConfigService], accessor).toBeDefined();
    }
  });
});
