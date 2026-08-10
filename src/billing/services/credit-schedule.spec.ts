import { describe, expect, it } from 'vitest';
import { ALLOCATION_KEYS } from '../billing.constants';
import { nextCreditAt } from './credit-schedule';

const SUBSCRIPTION = 'sub_annual';
const ANCHOR = new Date('2026-01-31T00:00:00.000Z');
const PAID_THROUGH = new Date('2027-01-31T00:00:00.000Z');

describe('the credit month schedule', () => {
  it('clamps into a short month rather than overflowing past it, then returns to the anchor day', () => {
    const february = nextCreditAt(ANCHOR, PAID_THROUGH);

    expect(february.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(nextCreditAt(february, PAID_THROUGH).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('walks an annual term as twelve distinct months and stops on the boundary, not inside it', () => {
    const keys: string[] = [];
    let at = ANCHOR;

    while (at < PAID_THROUGH) {
      keys.push(ALLOCATION_KEYS.month(SUBSCRIPTION, at));
      at = nextCreditAt(at, PAID_THROUGH);
    }

    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(12);
    expect(keys.at(-1)).toBe(`sub:${SUBSCRIPTION}:2026-12`);
    expect(at.toISOString()).toBe(PAID_THROUGH.toISOString());
  });
});
