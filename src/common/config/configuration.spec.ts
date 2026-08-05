import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from './app-config.service';
import { configurations, stripeConfig } from './configuration';

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
