import { CreditGrantSource } from '../generated/prisma/enums';

/**
 * The user's live subscription state for one Product, reduced to the two facts
 * spendability actually turns on.
 *
 * The caller resolves this from the live Subscription — a later phase authors
 * that model. Keeping it a parameter rather than a lookup is what makes the
 * rule a pure function, and what lets it be tested exhaustively without a
 * database or Stripe (design D1, D8).
 */
export type EntitlementState =
  { kind: 'none' } | { kind: 'live'; isPaidPlan: boolean; isPastDue: boolean };

export const NO_LIVE_SUBSCRIPTION: EntitlementState = { kind: 'none' };

/**
 * Whether credit from a given source is spendable right now (design D4).
 *
 * | Live subscription state | Subscription grants | Add-on grants |
 * |-------------------------|---------------------|---------------|
 * | Paid plan, active       | spendable           | spendable     |
 * | Paid plan, PAST_DUE     | frozen              | frozen        |
 * | Free plan, active       | spendable           | frozen        |
 * | none (transient)        | frozen              | frozen        |
 *
 * Freeze is never destructive: nothing here writes, expires, or zeroes a row.
 * The same grants become spendable again the moment the state changes back.
 */
export function isSourceSpendable(
  source: CreditGrantSource,
  state: EntitlementState,
): boolean {
  if (state.kind === 'none' || state.isPastDue) {
    return false;
  }

  // Add-on credit was bought outright and requires a live *paid* subscription
  // for its product; on Free it is preserved but unspendable.
  if (source === CreditGrantSource.ADDON) {
    return state.isPaidPlan;
  }

  // Subscription grants — and adjustments, which follow them — are spendable
  // whenever a live subscription is in good standing, whichever plan it is on.
  return true;
}

/** The grant sources spendable in a given state, for use as a query filter. */
export function spendableSources(state: EntitlementState): CreditGrantSource[] {
  return Object.values(CreditGrantSource).filter((source) =>
    isSourceSpendable(source, state),
  );
}

/**
 * Why consumption is currently refused, or `null` when it is not. Reported in
 * billing state so a frozen balance is explicable rather than mysterious.
 */
export type FreezeReason = 'PAST_DUE' | 'NO_LIVE_SUBSCRIPTION' | null;

export function freezeReasonFor(state: EntitlementState): FreezeReason {
  if (state.kind === 'none') {
    return 'NO_LIVE_SUBSCRIPTION';
  }
  return state.isPastDue ? 'PAST_DUE' : null;
}
