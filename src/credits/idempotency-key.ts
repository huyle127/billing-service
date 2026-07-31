/**
 * Idempotency key construction.
 *
 * Product-scoped operations put `productId` in the key. Without it, two
 * products sharing a `requestId` would deduplicate against each other and the
 * second consumption would silently not be charged — a correctness bug that
 * looks like a caching win, which is why the shape is specified rather than
 * left to judgement (design D4).
 */

/** `req:{userId}:{productId}:{requestId}:consume` */
export function consumeKey(
  userId: string,
  productId: string,
  requestId: string,
): string {
  return `req:${userId}:${productId}:${requestId}:consume`;
}

/**
 * Subscription-level keys stay scoped to the Subscription. The credit period's
 * start is what makes an allocation once-per-period rather than once-per-event,
 * so both the paid invoice and the scheduled reset derive the same key.
 */
export function subscriptionAllocationKey(
  subscriptionId: string,
  creditPeriodStart: Date,
): string {
  return `sub:${subscriptionId}:allocate:${creditPeriodStart.toISOString()}`;
}

/** Expiry of the period preceding a new allocation. */
export function subscriptionPeriodExpiryKey(
  subscriptionId: string,
  creditPeriodStart: Date,
): string {
  return `sub:${subscriptionId}:expire-prior:${creditPeriodStart.toISOString()}`;
}

/** Expiry of everything a departing Subscription granted. */
export function subscriptionDepartureExpiryKey(subscriptionId: string): string {
  return `sub:${subscriptionId}:expire-all`;
}

/** Add-on grants are scoped to the purchase that paid for them. */
export function addonGrantKey(addonPurchaseId: string): string {
  return `addon:${addonPurchaseId}:grant`;
}
