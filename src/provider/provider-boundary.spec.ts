import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ErrorCode } from '../common/errors/error-code';
import { SubscriptionStatus } from '../generated/prisma/enums';
import {
  PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS,
  isLive,
  isTerminal,
  toSubscriptionStatus,
} from '../subscriptions/subscription-status';
import { mapStripeError } from './stripe-error';

const SRC = join(__dirname, '..');

function typescriptFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'generated' ? [] : typescriptFilesUnder(path);
    }
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('the Stripe boundary', () => {
  describe('Requirement: Business Logic Is Decoupled From The Stripe SDK', () => {
    it('SDK usage is confined', () => {
      const offenders = typescriptFilesUnder(SRC)
        .filter((file) =>
          /(^|\n)\s*import\s[^;]*\sfrom\s+['"]stripe['"]/.test(
            readFileSync(file, 'utf8'),
          ),
        )
        .map((file) => relative(SRC, file).split(sep).join('/'));

      expect(offenders).toEqual(['provider/stripe-billing.provider.ts']);
    });
  });

  describe('Requirement: Stripe Is The Source Of Truth For Provider Billing State', () => {
    it('No invented subscription status', () => {
      const projected = new Set(
        Object.values(PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS),
      );

      for (const status of Object.values(SubscriptionStatus)) {
        expect(projected.has(status)).toBe(true);
      }
    });

    it("maps exactly Stripe's documented subscription statuses", () => {
      expect(
        Object.keys(PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS).sort(),
      ).toEqual([
        'active',
        'canceled',
        'incomplete',
        'incomplete_expired',
        'past_due',
        'paused',
        'trialing',
        'unpaid',
      ]);
    });

    it('holds no status meaning terminated, downgraded, or pending cancellation', () => {
      const names = Object.values(SubscriptionStatus).map((s) =>
        s.toLowerCase(),
      );

      expect(names).not.toContain('terminated');
      expect(names.some((n) => n.includes('downgrad'))).toBe(false);
      expect(names.some((n) => n.includes('pending'))).toBe(false);
      expect(names.some((n) => n.includes('free'))).toBe(false);
    });

    it('refuses a status the provider does not report', () => {
      expect(() => toSubscriptionStatus('downgraded')).toThrow();
    });
  });

  describe('live and terminal are classifications, not statuses', () => {
    it('treats active, trialing and past due as in force', () => {
      expect(isLive(SubscriptionStatus.ACTIVE)).toBe(true);
      expect(isLive(SubscriptionStatus.TRIALING)).toBe(true);
      // The grace period is still live: entitlement exists, consumption is
      // frozen by a separate rule.
      expect(isLive(SubscriptionStatus.PAST_DUE)).toBe(true);
    });

    it('treats a cancelled subscription as terminal and not live', () => {
      expect(isLive(SubscriptionStatus.CANCELED)).toBe(false);
      expect(isTerminal(SubscriptionStatus.CANCELED)).toBe(true);
    });

    it('treats an incomplete subscription as neither live nor terminal', () => {
      expect(isLive(SubscriptionStatus.INCOMPLETE)).toBe(false);
      expect(isTerminal(SubscriptionStatus.INCOMPLETE)).toBe(false);
    });
  });

  describe('Stripe errors map to standardised responses', () => {
    it('Card declined', () => {
      const mapped = mapStripeError({
        type: 'StripeCardError',
        code: 'card_declined',
        message: 'Your card was declined.',
      });

      expect(mapped.code).toBe(ErrorCode.PaymentFailed);
      expect(mapped.getStatus()).toBe(402);
    });

    it('Stripe unavailable', () => {
      const mapped = mapStripeError({
        type: 'StripeConnectionError',
        message: 'connection error',
      });

      expect(mapped.code).toBe(ErrorCode.StripeApiError);
      expect(mapped.getStatus()).toBe(503);
    });

    it('distinguishes a declined card from a service fault', () => {
      const declined = mapStripeError({ type: 'StripeCardError' });
      const fault = mapStripeError({ type: 'StripeAPIError' });

      expect(declined.code).not.toBe(fault.code);
    });

    it('Invalid payment method is a handled error', () => {
      const mapped = mapStripeError({
        type: 'StripeInvalidRequestError',
        code: 'payment_method_unactivated',
      });

      expect(mapped.code).toBe(ErrorCode.InvalidPaymentMethod);
      expect(mapped.getStatus()).toBe(400);
    });

    it('leaks no raw SDK error shape', () => {
      const mapped = mapStripeError(new Error('boom: secret internals'));

      expect(mapped.code).toBe(ErrorCode.StripeApiError);
      expect(mapped.message).not.toContain('secret internals');
    });
  });
});
