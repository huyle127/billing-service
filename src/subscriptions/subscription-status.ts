import { EntitlementState } from '../credits/spendability';
import { SubscriptionStatus } from '../generated/prisma/enums';

/**
 * Subscription status is the provider's, and local status is a synchronised
 * projection of it (design D0). Nothing in this file assigns a status: these
 * are *classifications over* the provider's values.
 *
 * `live` and `terminal` exist because the one-live-row constraint needs a set
 * to be partial over — not because a subscription is ever put into them.
 */

/** In force: entitlement applies, and the one-live-row index covers these. */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
];

/** Started but not yet in force — no entitlement, and not terminal either. */
export const PENDING_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.INCOMPLETE,
];

/** No longer in force. A row here is never returned to the live set. */
export const TERMINAL_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.INCOMPLETE_EXPIRED,
  SubscriptionStatus.CANCELED,
  SubscriptionStatus.UNPAID,
  SubscriptionStatus.PAUSED,
];

export function isLive(status: SubscriptionStatus): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.includes(status);
}

export function isTerminal(status: SubscriptionStatus): boolean {
  return TERMINAL_SUBSCRIPTION_STATUSES.includes(status);
}

/**
 * Every status Stripe reports for a subscription, mapped to its local
 * projection. Kept free of any Stripe SDK import so the mapping is testable
 * without credentials; the adapter is the only place that supplies the input.
 */
export const PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS: Readonly<
  Record<string, SubscriptionStatus>
> = {
  incomplete: SubscriptionStatus.INCOMPLETE,
  incomplete_expired: SubscriptionStatus.INCOMPLETE_EXPIRED,
  trialing: SubscriptionStatus.TRIALING,
  active: SubscriptionStatus.ACTIVE,
  past_due: SubscriptionStatus.PAST_DUE,
  canceled: SubscriptionStatus.CANCELED,
  unpaid: SubscriptionStatus.UNPAID,
  paused: SubscriptionStatus.PAUSED,
};

export function toSubscriptionStatus(
  providerStatus: string,
): SubscriptionStatus {
  const status = PROVIDER_STATUS_TO_SUBSCRIPTION_STATUS[providerStatus];
  if (!status) {
    throw new Error(
      `Unrecognised provider subscription status "${providerStatus}".`,
    );
  }
  return status;
}

/** The live Subscription's facts, as far as credit spendability is concerned. */
export interface LiveSubscriptionFacts {
  status: SubscriptionStatus;
  isPaidPlan: boolean;
}

/**
 * Bridges a Subscription to the entitlement state the credit rules consume.
 * Entitlement is *derived* from the live Subscription's plan and its
 * provider-reported status — never read from a separate flag.
 */
export function toEntitlementState(
  subscription: LiveSubscriptionFacts | null,
): EntitlementState {
  if (!subscription || !isLive(subscription.status)) {
    return { kind: 'none' };
  }
  return {
    kind: 'live',
    isPaidPlan: subscription.isPaidPlan,
    isPastDue: subscription.status === SubscriptionStatus.PAST_DUE,
  };
}
