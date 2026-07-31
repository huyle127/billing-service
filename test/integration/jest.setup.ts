import 'dotenv/config';
import { testDatabase, testDatabaseUrl } from './test-database';

// Anything that reads DATABASE_URL — including PrismaService inside a Nest
// testing module — must reach the disposable test database, not the
// development one.
process.env.DATABASE_URL = testDatabaseUrl();

// Business logic must run with no Stripe credentials and no network. Removing
// them here means any code path that reached the real Stripe adapter would
// fail loudly at construction instead of quietly working on someone's machine
// because their .env happened to be populated.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

// Each test starts from an empty database, so no test can depend on state a
// previous one happened to leave behind.
beforeEach(async () => {
  await testDatabase.truncateAll();
});

afterAll(async () => {
  await testDatabase.close();
});
