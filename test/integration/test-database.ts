import { PrismaPg } from '@prisma/adapter-pg';
import { Client as PgClient } from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and start the ' +
        'database with `npm run db:up`.',
    );
  }

  // The harness truncates every table between tests, so pointing it at the
  // development database would silently destroy data. Require the name to say
  // it is disposable.
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL must name a database ending in "_test"; got "${name}".`,
    );
  }

  return url;
}

/**
 * The integration tier runs against a real PostgreSQL instance, because half
 * the invariants in design D6 *are* database behaviour and an in-memory fake
 * would assert nothing (design D8).
 *
 * Connections opened through this helper are tracked and closed together, so a
 * test that opens a second connection for a concurrency check cannot leak it
 * into the next test.
 */
export class TestDatabase {
  private defaultClient?: PrismaClient;
  private readonly prismaClients: PrismaClient[] = [];
  private readonly pgClients: PgClient[] = [];

  /** The connection most tests use. */
  get prisma(): PrismaClient {
    this.defaultClient ??= this.newPrismaClient();
    return this.defaultClient;
  }

  /**
   * An additional, independent connection. Concurrency tests need two so that
   * two transactions genuinely interleave rather than serialising on one
   * connection — the guarantees under test are races (design D8).
   */
  newPrismaClient(): PrismaClient {
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrl() }),
    });
    this.prismaClients.push(client);
    return client;
  }

  /**
   * A raw connection, for the cases where the assertion is about the database
   * rejecting a write — constraint tests write the violating row directly
   * rather than going through the application.
   */
  async newPgClient(): Promise<PgClient> {
    const client = new PgClient({ connectionString: testDatabaseUrl() });
    await client.connect();
    this.pgClients.push(client);
    return client;
  }

  /**
   * Empties every table between tests. Tables are discovered rather than
   * listed, so this keeps working unchanged as each phase adds models.
   */
  async truncateAll(): Promise<void> {
    const tables = await this.prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT LIKE '_prisma%'
    `;

    if (tables.length === 0) {
      return;
    }

    const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
    await this.prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
    );
  }

  async close(): Promise<void> {
    await Promise.all(this.prismaClients.map((c) => c.$disconnect()));
    await Promise.all(this.pgClients.map((c) => c.end()));
    this.prismaClients.length = 0;
    this.pgClients.length = 0;
    this.defaultClient = undefined;
  }
}

export const testDatabase = new TestDatabase();
