import { testDatabase } from './test-database';

describe('integration harness', () => {
  it('reaches a real PostgreSQL database', async () => {
    const rows = await testDatabase.prisma.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one`;

    expect(rows).toEqual([{ one: 1 }]);
  });

  it('runs against a disposable test database', async () => {
    const rows = await testDatabase.prisma.$queryRaw<
      { name: string }[]
    >`SELECT current_database() AS name`;

    expect(rows[0].name).toMatch(/_test$/);
  });

  it('opens two independent connections for concurrency tests', async () => {
    const other = testDatabase.newPrismaClient();

    const [first] = await testDatabase.prisma.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    const [second] = await other.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;

    expect(first.pid).not.toBe(second.pid);
  });

  it('opens a raw connection for constraint tests', async () => {
    const client = await testDatabase.newPgClient();

    const result = await client.query<{ one: number }>('SELECT 1 AS one');

    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('truncates between tests without error on an empty schema', async () => {
    await expect(testDatabase.truncateAll()).resolves.toBeUndefined();
  });
});
