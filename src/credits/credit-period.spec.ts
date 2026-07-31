import { BillingInterval } from '../generated/prisma/enums';
import {
  addInterval,
  creditPeriodFrom,
  nextCreditPeriod,
} from './credit-period';

const MONTHLY = {
  creditsPerPeriod: 100,
  interval: BillingInterval.MONTH,
  intervalCount: 1,
};

function utc(iso: string): Date {
  return new Date(iso);
}

describe('credit-period arithmetic', () => {
  it('advances a month', () => {
    expect(
      addInterval(utc('2026-03-14T10:00:00.000Z'), BillingInterval.MONTH),
    ).toEqual(utc('2026-04-14T10:00:00.000Z'));
  });

  it('advances a year', () => {
    expect(
      addInterval(utc('2026-03-14T10:00:00.000Z'), BillingInterval.YEAR),
    ).toEqual(utc('2027-03-14T10:00:00.000Z'));
  });

  it('clamps a day the target month does not have', () => {
    // Otherwise 31 January plus a month would land in March and the February
    // period would be skipped.
    expect(
      addInterval(utc('2026-01-31T00:00:00.000Z'), BillingInterval.MONTH),
    ).toEqual(utc('2026-02-28T00:00:00.000Z'));
    expect(
      addInterval(utc('2028-01-31T00:00:00.000Z'), BillingInterval.MONTH),
    ).toEqual(utc('2028-02-29T00:00:00.000Z'));
  });

  it('clamps 29 February to 28 February a non-leap year later', () => {
    expect(
      addInterval(utc('2028-02-29T00:00:00.000Z'), BillingInterval.YEAR),
    ).toEqual(utc('2029-02-28T00:00:00.000Z'));
  });

  it('derives a monthly credit period from the plan policy', () => {
    const period = creditPeriodFrom(utc('2026-07-28T00:00:00.000Z'), MONTHLY);

    expect(period).toEqual({
      start: utc('2026-07-28T00:00:00.000Z'),
      end: utc('2026-08-28T00:00:00.000Z'),
    });
  });

  it('tiles twelve monthly periods across an annual billing period', () => {
    // The divergence the scheduled reset exists for: one invoice, twelve
    // credit periods, no month skipped and none doubled.
    const billingStart = utc('2026-01-31T00:00:00.000Z');
    const periods = [creditPeriodFrom(billingStart, MONTHLY)];
    for (let month = 1; month < 12; month++) {
      periods.push(nextCreditPeriod(periods[periods.length - 1], MONTHLY));
    }

    expect(periods).toHaveLength(12);
    for (const [index, period] of periods.entries()) {
      expect(period.end.getTime()).toBeGreaterThan(period.start.getTime());
      if (index > 0) {
        expect(period.start).toEqual(periods[index - 1].end);
      }
    }
    // Twelve monthly periods reach the annual boundary without passing it.
    const annualEnd = addInterval(billingStart, BillingInterval.YEAR);
    expect(periods[11].end.getTime()).toBeLessThanOrEqual(annualEnd.getTime());
    expect(periods[11].start.getTime()).toBeLessThan(annualEnd.getTime());
  });

  it('does not let a clamped month shorten every later period', () => {
    // 31 → 28 must not stick: the following period returns to the 28th of the
    // next month rather than drifting backwards again.
    const first = creditPeriodFrom(utc('2026-01-31T00:00:00.000Z'), MONTHLY);
    const second = nextCreditPeriod(first, MONTHLY);

    expect(second.start).toEqual(utc('2026-02-28T00:00:00.000Z'));
    expect(second.end).toEqual(utc('2026-03-28T00:00:00.000Z'));
  });
});
