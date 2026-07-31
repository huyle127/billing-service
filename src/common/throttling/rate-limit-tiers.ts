import { STRIPE_WEBHOOK_PATH } from '../constants';

/**
 * What a request rate ceiling costs to abuse, expressed as four tiers.
 *
 * The numbers are a starting point to be reviewed against real traffic, not a
 * derived result. What is *not* provisional is the shape: every route belongs to
 * exactly one tier or to the exempt set, decided by {@link rateLimitTierFor}
 * alone. A route cannot quietly acquire a second budget by being matched twice,
 * and a new route cannot arrive unlimited by omission — anything unrecognised
 * lands in `default`.
 */

const MINUTE_MS = 60_000;

export type RateLimitTier = 'auth' | 'checkout' | 'consume' | 'default';

export const RATE_LIMIT_TIERS: readonly RateLimitTier[] = [
  'auth',
  'checkout',
  'consume',
  'default',
];

export const RATE_LIMITS: Record<
  RateLimitTier,
  { readonly ttlMs: number; readonly limit: number }
> = {
  /** Brute force and credential stuffing. */
  auth: { ttlMs: MINUTE_MS, limit: 5 },
  /** Each request creates a real Stripe object. */
  checkout: { ttlMs: MINUTE_MS, limit: 10 },
  /** Spends a money-equivalent balance. */
  consume: { ttlMs: MINUTE_MS, limit: 60 },
  /** Default ceiling. */
  default: { ttlMs: MINUTE_MS, limit: 100 },
};

/**
 * Tiers counted against the authenticated user rather than the source address.
 *
 * These protect a balance or a provider account, both of which belong to a user
 * — counting them per address would let one user behind a shared address exhaust
 * another's budget, and would let one user with several addresses exceed their
 * own. The remaining tiers are per address because the caller has no identity
 * yet, which is the whole point of limiting them.
 */
const PER_USER_TIERS: ReadonlySet<RateLimitTier> = new Set([
  'checkout',
  'consume',
]);

export function isPerUserTier(tier: RateLimitTier): boolean {
  return PER_USER_TIERS.has(tier);
}

/**
 * Routes subject to no rate limit at all.
 *
 * - **The provider webhook.** Stripe bursts deliveries — a backlog after an
 *   outage arrives at once — and treats a 429 as a failure worth retrying. The
 *   retry meets the same limit, so a limit here converts a spike into a stall
 *   and delays the very events it was meant to protect. Its protection is
 *   signature verification, which no rate limit contributes to.
 * - **The health check.** An orchestrator probes it on a fixed schedule from a
 *   small number of addresses. A 429 there reads as an unhealthy service and
 *   gets the container killed.
 */
const UNLIMITED_PATHS: ReadonlySet<string> = new Set([
  STRIPE_WEBHOOK_PATH,
  '/health',
]);

/**
 * The tier a request belongs to, or `null` when it is exempt.
 *
 * Takes the method and path rather than a request object so it is a pure
 * function of the routing decision, and can be asserted directly.
 */
export function rateLimitTierFor(
  method: string,
  path: string,
): RateLimitTier | null {
  const route = normalisePath(path);

  if (UNLIMITED_PATHS.has(route)) {
    return null;
  }

  // Every auth route, whatever it is and whatever method it takes. Written as a
  // prefix rather than a list of the two that exist today so a third arrives
  // limited rather than arriving under the default ceiling.
  if (route === '/auth' || route.startsWith('/auth/')) {
    return 'auth';
  }

  if (method === 'POST') {
    if (route === '/subscriptions' || route === '/addons') {
      return 'checkout';
    }
    if (route === '/credits/consume') {
      return 'consume';
    }
  }

  return 'default';
}

/**
 * Collapses the spellings of one route to a single key, so that a trailing
 * slash or a query string cannot be used to land in a different tier.
 */
function normalisePath(path: string): string {
  const withoutQuery = path.split('?')[0];
  return withoutQuery.replace(/\/+$/, '') || '/';
}
