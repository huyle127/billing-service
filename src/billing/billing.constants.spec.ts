import { describe, expect, it } from 'vitest';
import { ALLOCATION_KEYS } from './billing.constants';

describe('the allocation key', () => {
  it('names one UTC month for a whole month, and names the next one differently', () => {
    const opening = new Date('2026-08-01T00:00:00.000Z');
    const closing = new Date('2026-08-31T23:59:59.999Z');
    const following = new Date('2026-09-01T00:00:00.000Z');

    expect(ALLOCATION_KEYS.month('sub_1', opening)).toBe('sub:sub_1:2026-08');
    expect(ALLOCATION_KEYS.month('sub_1', closing)).toBe(ALLOCATION_KEYS.month('sub_1', opening));
    expect(ALLOCATION_KEYS.month('sub_1', following)).toBe('sub:sub_1:2026-09');
  });

  it('separates two subscriptions in the same month', () => {
    const at = new Date('2026-08-15T12:00:00.000Z');

    expect(ALLOCATION_KEYS.month('sub_1', at)).not.toBe(ALLOCATION_KEYS.month('sub_2', at));
  });
});
