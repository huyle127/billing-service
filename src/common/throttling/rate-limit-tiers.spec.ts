import { isPerUserTier, rateLimitTierFor } from './rate-limit-tiers';

/**
 * The routing table behind the rate limit. The integration suite asserts what
 * each tier *does*; this asserts which routes land in it, including the ones
 * that would be expensive to exercise a hundred times over HTTP.
 */

describe('rateLimitTierFor', () => {
  it('exempts the provider webhook and the health check', () => {
    expect(rateLimitTierFor('POST', '/webhooks/stripe')).toBeNull();
    expect(rateLimitTierFor('GET', '/health')).toBeNull();
  });

  it('puts every auth route in the auth tier', () => {
    expect(rateLimitTierFor('POST', '/auth/login')).toBe('auth');
    expect(rateLimitTierFor('POST', '/auth/register')).toBe('auth');
    // A route that does not exist yet. The prefix is what makes a third auth
    // endpoint arrive limited rather than under the default ceiling.
    expect(rateLimitTierFor('POST', '/auth/refresh')).toBe('auth');
  });

  it('puts the two checkout-creating routes in the checkout tier', () => {
    expect(rateLimitTierFor('POST', '/subscriptions')).toBe('checkout');
    expect(rateLimitTierFor('POST', '/addons')).toBe('checkout');
  });

  it('does not treat reads or lifecycle writes as checkout creation', () => {
    // Only the method and path that create a provider object are bounded at
    // ten a minute; cancelling or listing costs nothing at the provider.
    expect(rateLimitTierFor('GET', '/subscriptions')).toBe('default');
    expect(rateLimitTierFor('GET', '/addons')).toBe('default');
    expect(rateLimitTierFor('POST', '/subscriptions/abc/cancel')).toBe(
      'default',
    );
    expect(rateLimitTierFor('PATCH', '/subscriptions/abc/cycle')).toBe(
      'default',
    );
  });

  it('bounds credit spending and not credit reading', () => {
    expect(rateLimitTierFor('POST', '/credits/consume')).toBe('consume');
    expect(rateLimitTierFor('GET', '/credits/balance')).toBe('default');
    expect(rateLimitTierFor('GET', '/credits/history')).toBe('default');
  });

  it('gives an unrecognised route the default ceiling rather than none', () => {
    // A new route arrives limited by omission, not unlimited by omission.
    expect(rateLimitTierFor('GET', '/something/new')).toBe('default');
    expect(rateLimitTierFor('POST', '/')).toBe('default');
  });

  it('cannot be moved into another tier by respelling the path', () => {
    // A trailing slash or a query string must not be a way out of the auth
    // tier and into the twenty-times-larger default one.
    expect(rateLimitTierFor('POST', '/auth/login/')).toBe('auth');
    expect(rateLimitTierFor('POST', '/auth/login?x=1')).toBe('auth');
    expect(rateLimitTierFor('POST', '/webhooks/stripe/')).toBeNull();
    expect(rateLimitTierFor('POST', '/subscriptions/')).toBe('checkout');
  });
});

describe('how a tier is counted', () => {
  it('counts what a user owns against the user, and the rest against the address', () => {
    // The split is not cosmetic: it is the same thing that decides which side
    // of the JWT guard each tier's guard sits on.
    expect(isPerUserTier('checkout')).toBe(true);
    expect(isPerUserTier('consume')).toBe(true);
    expect(isPerUserTier('auth')).toBe(false);
    expect(isPerUserTier('default')).toBe(false);
  });
});
