import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  get nodeEnv(): string {
    return this.config.getOrThrow<string>('app.nodeEnv');
  }

  get port(): number {
    return this.config.getOrThrow<number>('app.port');
  }

  get internalApiKey(): string {
    return this.config.getOrThrow<string>('app.internalApiKey');
  }

  get creditAllocationCron(): string {
    return this.config.getOrThrow<string>('app.creditAllocationCron');
  }

  get databaseUrl(): string {
    return this.config.getOrThrow<string>('database.url');
  }

  get directUrl(): string {
    return this.config.getOrThrow<string>('database.directUrl');
  }

  get jwtSecret(): string {
    return this.config.getOrThrow<string>('auth.jwtSecret');
  }

  get accessTokenTtl(): string {
    return this.config.getOrThrow<string>('auth.accessTokenTtl');
  }

  get refreshTokenTtl(): string {
    return this.config.getOrThrow<string>('auth.refreshTokenTtl');
  }

  get bcryptSaltRounds(): number {
    return this.config.getOrThrow<number>('auth.bcryptSaltRounds');
  }

  get stripeSecretKey(): string {
    return this.config.getOrThrow<string>('stripe.secretKey');
  }

  get stripeWebhookSecrets(): string[] {
    return this.config.getOrThrow<string[]>('stripe.webhookSecrets');
  }

  get webhookPollIntervalMs(): number {
    return this.config.getOrThrow<number>('webhook.pollIntervalMs');
  }

  get webhookBatchSize(): number {
    return this.config.getOrThrow<number>('webhook.batchSize');
  }

  get webhookMaxRetryCount(): number {
    return this.config.getOrThrow<number>('webhook.maxRetryCount');
  }

  get webhookRetryBackoffMs(): number {
    return this.config.getOrThrow<number>('webhook.retryBackoffMs');
  }
}
