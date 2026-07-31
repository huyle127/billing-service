import 'dotenv/config';
import { execSync } from 'node:child_process';

/**
 * Brings the test database up to the current schema once per run, including the
 * raw-SQL constraint migrations — the invariants in design D6 only hold if
 * those are applied, so `migrate deploy` is used rather than `db push`.
 */
export default function globalSetup(): void {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Copy .env.example to .env and start the ' +
        'database with `npm run db:up`.',
    );
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
