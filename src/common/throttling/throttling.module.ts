import { ExecutionContext, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../auth/current-user.decorator';
import {
  RATE_LIMITS,
  RATE_LIMIT_TIERS,
  RateLimitTier,
  isPerUserTier,
  rateLimitTierFor,
} from './rate-limit-tiers';
import { IpRateLimitGuard, UserRateLimitGuard } from './rate-limit.guards';

/**
 * The request rate ceiling, bound globally in two halves.
 *
 * The bindings live here rather than in `AppModule` for the same reason
 * `AuthModule` owns the JWT guard: importing a module is what applies the
 * limits, so there is no way to have them configured and not enforced.
 *
 * **The two halves must bracket the JWT guard**, which is why they are separate
 * modules with an ordering requirement stated at each import site rather than
 * one module doing both. See `rate-limit.guards.ts` for why each half sits
 * where it does.
 */

/**
 * Set to `false` to disable enforcement. Enforcement is the default and only
 * this exact value turns it off, so a missing or misspelled variable leaves the
 * service protected.
 *
 * It exists for the integration suite: those tests register a user per case
 * from one address, which would exhaust a five-per-minute auth budget within a
 * few tests and turn every suite into a rate-limit test. The suite that *is*
 * about rate limiting enables it and asserts the real, unmodified tiers.
 */
export const RATE_LIMITING_ENABLED = 'RATE_LIMITING_ENABLED';

/**
 * The tier definitions and the address-keyed half of the enforcement. Imported
 * **before** `AuthModule`.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const enabled = config.get<string>(RATE_LIMITING_ENABLED) !== 'false';

        return {
          // Replaces the library's default, which names its own exception
          // class. A refusal says only that too many requests arrived: not
          // which tier refused it, and — for the auth tier — nothing about
          // whether the account exists.
          errorMessage:
            'Too many requests. Retry once the rate limit window elapses.',
          throttlers: RATE_LIMIT_TIERS.map((tier) => ({
            name: tier,
            ttl: RATE_LIMITS[tier].ttlMs,
            limit: RATE_LIMITS[tier].limit,

            // Each tier declines every request that is not its own, so a route
            // is counted against exactly one budget. Without this, every named
            // throttler would apply to every route at once.
            skipIf: (context: ExecutionContext) =>
              !enabled || tierOf(context) !== tier,

            getTracker: (request: Record<string, unknown>) =>
              trackerFor(tier, request as unknown as Request),

            // Deliberately replaces the default key, which includes the
            // controller and handler names and so gives each *route* its own
            // budget. The design states these limits per route group, so the
            // group is the budget: the two checkout routes share ten a minute
            // between them rather than getting ten each.
            generateKey: (
              _context: ExecutionContext,
              tracker: string,
              name: string,
            ) => `${name}:${tracker}`,
          })),
        };
      },
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: IpRateLimitGuard }],
})
export class RateLimitModule {}

/**
 * The user-keyed half. Imported **after** `AuthModule`, so the principal it
 * counts against is on the request by the time it runs.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: UserRateLimitGuard }],
})
export class UserRateLimitModule {}

function tierOf(context: ExecutionContext): RateLimitTier | null {
  const request = context.switchToHttp().getRequest<Request>();
  return rateLimitTierFor(request.method, request.path);
}

/**
 * What the tier counts against.
 *
 * A per-user tier falls back to the address when no principal is present. That
 * path is not reached in practice — the guard owning those tiers runs after the
 * JWT guard, which refuses an unauthenticated caller first — and the fallback
 * exists so that a future public route in one of those tiers is counted rather
 * than sharing one bucket with every other anonymous caller.
 */
function trackerFor(tier: RateLimitTier, request: Request): string {
  if (isPerUserTier(tier)) {
    const user = request.user as AuthenticatedUser | undefined;
    if (user?.userId) {
      return `user:${user.userId}`;
    }
  }
  return `ip:${request.ip ?? 'unknown'}`;
}
