/**
 * Where the provider returns the customer once a hosted checkout ends.
 *
 * Both checkout flows — a Pro subscription and a one-time add-on — take the same
 * pair, and so does the provider seam they both call. Naming it once keeps the
 * three declarations from drifting apart, and gives the API layer a shape to
 * validate rather than two near-identical ones.
 */
export interface CheckoutRedirectUrls {
  successUrl: string;
  cancelUrl: string;
}
