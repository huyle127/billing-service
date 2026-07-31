import { Prisma } from '../generated/prisma/client';

/**
 * A unique-constraint rejection from PostgreSQL.
 *
 * Several flows treat one of these as an ordinary outcome rather than a fault:
 * the loser of a concurrent provisioning, a replayed consumption, a credit
 * period two allocation paths both fell due for. Recognising it in one place
 * keeps "the constraint is the arbiter" a shared idiom instead of three
 * slightly different ones (design D6).
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * A failure that came from the database rather than from billing logic.
 *
 * Recognised at the HTTP boundary so that a write the database refused is
 * reported as `DATABASE_TRANSACTION_FAILED` rather than as an opaque internal
 * error — the flows above treat the constraints as the arbiter, so a violation
 * one of them did not expect is still a database outcome and says so.
 */
export function isDatabaseError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientRustPanicError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientValidationError
  );
}

/**
 * Whether retrying the same request could plausibly succeed: a write conflict
 * or deadlock the database resolved by aborting one side, or a pool timeout.
 * These deserve a 503 and a retry, where a rejected constraint deserves neither.
 */
export function isTransientDatabaseError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2024')
  );
}
