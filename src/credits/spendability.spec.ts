import { CreditGrantSource } from '../generated/prisma/enums';
import {
  EntitlementState,
  freezeReasonFor,
  isSourceSpendable,
  spendableSources,
} from './spendability';

const PAID_ACTIVE: EntitlementState = {
  kind: 'live',
  isPaidPlan: true,
  isPastDue: false,
};
const PAID_PAST_DUE: EntitlementState = {
  kind: 'live',
  isPaidPlan: true,
  isPastDue: true,
};
const FREE_ACTIVE: EntitlementState = {
  kind: 'live',
  isPaidPlan: false,
  isPastDue: false,
};
const FREE_PAST_DUE: EntitlementState = {
  kind: 'live',
  isPaidPlan: false,
  isPastDue: true,
};
const NONE: EntitlementState = { kind: 'none' };

describe('spendability (design D4)', () => {
  describe('the derivation table, exhaustively', () => {
    const cases: [string, EntitlementState, boolean, boolean][] = [
      // state name              state            subscription  add-on
      ['paid plan, active', PAID_ACTIVE, true, true],
      ['paid plan, past due', PAID_PAST_DUE, false, false],
      ['free plan, active', FREE_ACTIVE, true, false],
      ['free plan, past due', FREE_PAST_DUE, false, false],
      ['no live subscription', NONE, false, false],
    ];

    it.each(cases)(
      '%s',
      (_name, state, subscriptionSpendable, addonSpendable) => {
        expect(isSourceSpendable(CreditGrantSource.SUBSCRIPTION, state)).toBe(
          subscriptionSpendable,
        );
        expect(isSourceSpendable(CreditGrantSource.ADDON, state)).toBe(
          addonSpendable,
        );
      },
    );
  });

  it('treats adjustment grants like subscription grants', () => {
    expect(isSourceSpendable(CreditGrantSource.ADJUSTMENT, FREE_ACTIVE)).toBe(
      true,
    );
    expect(isSourceSpendable(CreditGrantSource.ADJUSTMENT, PAID_PAST_DUE)).toBe(
      false,
    );
  });

  it('reports no spendable sources at all while past due', () => {
    expect(spendableSources(PAID_PAST_DUE)).toEqual([]);
    expect(spendableSources(NONE)).toEqual([]);
  });

  it('excludes only add-on credit on a free plan', () => {
    expect(spendableSources(FREE_ACTIVE)).not.toContain(
      CreditGrantSource.ADDON,
    );
    expect(spendableSources(FREE_ACTIVE)).toContain(
      CreditGrantSource.SUBSCRIPTION,
    );
  });

  describe('freeze reason', () => {
    it('is absent when nothing is frozen', () => {
      expect(freezeReasonFor(PAID_ACTIVE)).toBeNull();
      expect(freezeReasonFor(FREE_ACTIVE)).toBeNull();
    });

    it('distinguishes past due from having no live subscription', () => {
      expect(freezeReasonFor(PAID_PAST_DUE)).toBe('PAST_DUE');
      expect(freezeReasonFor(NONE)).toBe('NO_LIVE_SUBSCRIPTION');
    });
  });
});
