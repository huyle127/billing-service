/**
 * The one route whose body must reach the handler as raw bytes, because Stripe
 * signatures verify against the exact payload received and a re-serialised body
 * will not verify (design D5).
 */
export const STRIPE_WEBHOOK_PATH = '/webhooks/stripe';

/**
 * Where a caller declares that a request is a repeat of one it never saw
 * answered, rather than a new operation.
 *
 * Only the caller can tell those apart, which is why this is a header and not
 * something the service derives. A key built from the user and the SKU would
 * answer "has this been bought before" — a question the database already
 * answers, and the wrong one for deciding whether *this call* got through.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
