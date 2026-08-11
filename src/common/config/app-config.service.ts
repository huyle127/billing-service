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

  get allocationCron(): string {
    return this.config.getOrThrow<string>('allocation.cron');
  }

  get allocationBatchSize(): number {
    return this.config.getOrThrow<number>('allocation.batchSize');
  }

  get catalogCron(): string {
    return this.config.getOrThrow<string>('catalog.cron');
  }

  get catalogBatchSize(): number {
    return this.config.getOrThrow<number>('catalog.batchSize');
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

  get provisioningSweepIntervalMs(): number {
    return this.config.getOrThrow<number>('provisioning.sweepIntervalMs');
  }

  get provisioningBatchSize(): number {
    return this.config.getOrThrow<number>('provisioning.batchSize');
  }

  get provisioningRetryBackoffMs(): number {
    return this.config.getOrThrow<number>('provisioning.retryBackoffMs');
  }

  get provisioningStaleAfterMs(): number {
    return this.config.getOrThrow<number>('provisioning.staleAfterMs');
  }
}
