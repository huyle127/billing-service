import { BillingInterval } from '../generated/prisma/enums';

/**
 * How much credit one credit period grants, and how long that period lasts.
 *
 * This is the Plan's policy, deliberately separate from any PricingOption's
 * billing interval: Pro Annual bills once a year and resets credits monthly
 * (design D4).
 */
export interface CreditPolicy {
  creditsPerPeriod: number;
  interval: BillingInterval;
  intervalCount: number;
}

/** The subset of a Plan the credit policy is derived from. */
export interface PlanCreditPolicyFields {
  creditsPerPeriod: number;
  creditPeriodInterval: BillingInterval;
  creditPeriodIntervalCount: number;
}

/**
 * Reads a plan's credit policy. Allocation goes through this rather than
 * reading an amount from a constant, so changing a plan's credit amount in the
 * catalog changes what subsequent grants are worth with no code change.
 */
export function creditPolicyOf(plan: PlanCreditPolicyFields): CreditPolicy {
  return {
    creditsPerPeriod: plan.creditsPerPeriod,
    interval: plan.creditPeriodInterval,
    intervalCount: plan.creditPeriodIntervalCount,
  };
}
