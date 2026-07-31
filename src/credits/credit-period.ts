import type { CreditPolicy } from '../catalog/credit-policy';
import { BillingInterval } from '../generated/prisma/enums';

/**
 * Credit-period arithmetic.
 *
 * A credit period comes from the Plan's credit policy and is independent of the
 * PricingOption's billing interval: Pro Annual bills once a year and resets
 * credits monthly, so one billing period spans twelve credit periods (design
 * D4). Deriving the period from the plan rather than from the provider's billing
 * boundaries is what keeps those twelve from collapsing into one.
 *
 * Pure functions, so the annual/monthly divergence is testable without a clock,
 * a database, or Stripe.
 */

export interface CreditPeriod {
  start: Date;
  end: Date;
}

const MONTHS_PER_YEAR = 12;

/**
 * Adds whole months in UTC, clamping the day to the target month's length —
 * 31 January plus one month is 28 February, not 3 March. Without the clamp a
 * subscription created on the 31st would drift forward a few days every short
 * month and eventually skip a period boundary.
 */
function addMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const firstOfTarget = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth() + months,
    1,
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  );
  const target = new Date(firstOfTarget);

  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target;
}

export function addInterval(
  from: Date,
  interval: BillingInterval,
  intervalCount = 1,
): Date {
  const months =
    interval === BillingInterval.YEAR
      ? MONTHS_PER_YEAR * intervalCount
      : intervalCount;
  return addMonths(from, months);
}

/** The credit period beginning at `start`, per the plan's policy. */
export function creditPeriodFrom(
  start: Date,
  policy: CreditPolicy,
): CreditPeriod {
  return {
    start,
    end: addInterval(start, policy.interval, policy.intervalCount),
  };
}

/** The period following `period`, so periods tile without gap or overlap. */
export function nextCreditPeriod(
  period: CreditPeriod,
  policy: CreditPolicy,
): CreditPeriod {
  return creditPeriodFrom(period.end, policy);
}
