import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach } from 'vitest';

const url = process.env.DATABASE_URL_TEST;

if (!url) {
  throw new Error(
    'DATABASE_URL_TEST is not set. Tests must never run against the development database — ' +
      'point it at a dedicated Neon branch.',
  );
}

if (url === process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL_TEST is identical to DATABASE_URL. Tests truncate every table; ' +
      'pointing them at the development database would destroy it.',
  );
}

process.env.DATABASE_URL = url;

export const testPrisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});

const TABLES = [
  'CreditTransaction',
  'CreditWallet',
  'SubscriptionEvent',
  'Subscription',
  'PaymentTransaction',
  'PaymentMethod',
  'BillingCustomer',
  'AuthCredential',
  'WebhookEvent',
  'User',
];

export async function truncateAll(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await testPrisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await testPrisma.$disconnect();
});
