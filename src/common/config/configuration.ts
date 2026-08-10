import { registerAs } from '@nestjs/config';

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function integer(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Configuration ${key} must be a non-negative integer, received "${raw}"`);
  }
  return value;
}

function secretList(key: string): string[] {
  const values = required(key)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`Configuration ${key} must contain at least one value`);
  return values;
}

export const appConfig = registerAs('app', () => ({
  nodeEnv: optional('NODE_ENV', 'development'),
  port: integer('PORT', 3000),
  internalApiKey: required('INTERNAL_API_KEY'),
  creditAllocationCron: optional('CREDIT_ALLOCATION_CRON', '0 3 * * *'),
}));

export const databaseConfig = registerAs('database', () => ({
  url: required('DATABASE_URL'),
  directUrl: required('DIRECT_URL'),
}));

export const authConfig = registerAs('auth', () => ({
  jwtSecret: required('JWT_SECRET'),
  accessTokenTtl: optional('JWT_ACCESS_TOKEN_TTL', '15m'),
  refreshTokenTtl: optional('JWT_REFRESH_TOKEN_TTL', '30d'),
  bcryptSaltRounds: integer('BCRYPT_SALT_ROUNDS', 12),
}));

export const stripeConfig = registerAs('stripe', () => ({
  secretKey: required('STRIPE_SECRET_KEY'),
  webhookSecrets: secretList('STRIPE_WEBHOOK_SECRET'),
}));

export const provisioningConfig = registerAs('provisioning', () => ({
  sweepIntervalMs: integer('PROVISIONING_SWEEP_INTERVAL_MS', 60000),
  batchSize: integer('PROVISIONING_BATCH_SIZE', 50),
  retryBackoffMs: integer('PROVISIONING_RETRY_BACKOFF_MS', 60000),
  staleAfterMs: integer('PROVISIONING_STALE_AFTER_MS', 3600000),
}));

export const configurations = [
  appConfig,
  databaseConfig,
  authConfig,
  stripeConfig,
  provisioningConfig,
];
