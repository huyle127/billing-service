import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { RateLimitTier, isPerUserTier } from './rate-limit-tiers';

/**
 * Two guards rather than one, because the tiers need opposite positions
 * relative to the JWT guard and a single guard can only be in one place.
 *
 * - The **address-keyed** tiers must run *before* authentication. Their job
 *   includes bounding callers who have no valid token at all — a flood of
 *   requests carrying a bogus token is exactly what a default ceiling is for,
 *   and a guard sitting after the JWT guard would never be reached by one,
 *   because the JWT guard would have refused it first. Uncounted is unlimited.
 * - The **user-keyed** tiers must run *after* it, because the principal they
 *   count against is what the JWT guard puts on the request. Running earlier,
 *   they would find none and silently degrade to counting per address — a limit
 *   that still appears to work while measuring something else.
 *
 * Both share the one set of tier definitions and the one storage; each simply
 * declines to evaluate the tiers that are not its own. The split is by *how a
 * tier is keyed*, which is the same thing that decides where it must sit, so
 * the two cannot drift apart.
 */

abstract class TierScopedThrottlerGuard extends ThrottlerGuard {
  protected abstract owns(tier: RateLimitTier): boolean;

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = this.throttlers.filter((throttler) =>
      this.owns(throttler.name as RateLimitTier),
    );
  }
}

/** Runs before the JWT guard. Owns the tiers counted per source address. */
@Injectable()
export class IpRateLimitGuard extends TierScopedThrottlerGuard {
  protected owns(tier: RateLimitTier): boolean {
    return !isPerUserTier(tier);
  }
}

/** Runs after the JWT guard. Owns the tiers counted per authenticated user. */
@Injectable()
export class UserRateLimitGuard extends TierScopedThrottlerGuard {
  protected owns(tier: RateLimitTier): boolean {
    return isPerUserTier(tier);
  }
}
