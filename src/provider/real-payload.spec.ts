import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkoutCompletionOf,
  toProviderInvoice,
  toProviderSubscription,
} from './stripe-billing.provider';

/**
 * The translators, against payloads Stripe actually produced.
 *
 * Every other test in this repository runs against `FakeBillingProvider`, which
 * constructs provider DTOs directly and so never exercises a single field path
 * in these functions. That gap is not theoretical: it is why a 310-test suite
 * stayed green while `paymentIntentId` was null on every subscription payment
 * the service could ever record.
 *
 * The fixtures are genuine output from Stripe test account
 * `acct_1TlhMSFaNFL0w4nv`, captured 2026-07-29 — a real recurring subscription,
 * its real `invoice.paid` delivery, and the same invoice retrieved with
 * `expand[0]=payments`. Keeping both the delivered and the retrieved form is
 * the whole point: the difference between them *is* the defect.
 *
 * No Stripe type is imported here. `provider-boundary.spec.ts` requires that
 * the adapter is the only module importing the SDK, and it scans spec files
 * too, so the payload types are derived from the functions' own signatures.
 */

const FIXTURES = join(__dirname, '..', '..', 'test', 'fixtures', 'stripe');

type StripeInvoice = Parameters<typeof toProviderInvoice>[0];
type StripeSubscription = Parameters<typeof toProviderSubscription>[0];
type StripeSession = Parameters<typeof checkoutCompletionOf>[0];

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

/** The `data.object` of a captured event, as the webhook would receive it. */
function delivered<T>(name: string): T {
  return fixture<{ data: { object: T } }>(name).data.object;
}

/**
 * Only real property accesses count. Comments discuss these field paths at
 * length, and the event-type literals (`'customer.subscription.updated'`,
 * `'invoice.paid'`) look exactly like them to a regex — so both are removed
 * before anything is read as a field access.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');
}

describe('the translators against real Stripe payloads', () => {
  describe('toProviderInvoice', () => {
    const fromDelivery = toProviderInvoice(
      delivered<StripeInvoice>('invoice-paid.delivered-event'),
    );
    const fromExpanded = toProviderInvoice(
      fixture<StripeInvoice>('invoice.expanded-retrieval'),
    );
    const fromUnexpanded = toProviderInvoice(
      fixture<StripeInvoice>('invoice.unexpanded-retrieval'),
    );

    it('resolves the version-sensitive subscription and price paths', () => {
      // `line.parent.subscription_item_details.subscription` and
      // `line.pricing.price_details.price`. These are the paths whose silent
      // resolution to undefined would stop credit allocation entirely, so they
      // are asserted against a payload rather than trusted to typecheck.
      expect(fromDelivery).toMatchObject({
        id: 'in_1TyRotFaNFL0w4nvPWmXWWpu',
        providerSubscriptionId: 'sub_1TyRotFaNFL0w4nvFNMuG7Dz',
        priceId: 'price_1TyRojFaNFL0w4nvb4DY20uP',
        customerId: 'cus_UyObIRDznHwQ9E',
        amountPaid: 2000,
        currency: 'usd',
        billingReason: 'subscription_create',
      });
      expect(fromDelivery.periodStart).not.toBeNull();
      expect(fromDelivery.periodEnd).not.toBeNull();
    });

    it('finds no payment intent on a delivered invoice', () => {
      // Not a defect in this function — `payments` is an expandable field, and
      // a webhook delivery carries no request with which to expand it. This is
      // the observation the whole change rests on, pinned so that nobody
      // "fixes" it by making the fake provider supply a value instead.
      expect(fromDelivery.paymentIntentId).toBeNull();
    });

    it('finds none on an unexpanded retrieval either', () => {
      // Confirms the cause is the missing expansion rather than anything
      // specific to how events are rendered.
      expect(fromUnexpanded.paymentIntentId).toBeNull();
    });

    it('finds the payment intent once payments is expanded', () => {
      expect(fromExpanded.paymentIntentId).toBe('pi_3TyRotFaNFL0w4nv11x3z7a5');
    });

    it('differs from the delivered form in that one field and no other', () => {
      // If expanding ever changed something else, the retrieval would be an
      // unsafe substitute for the delivery and the fix would be silently
      // rewriting more than it claims to.
      expect({ ...fromExpanded, paymentIntentId: null }).toEqual(fromDelivery);
    });
  });

  describe('toProviderSubscription', () => {
    const fromRetrieval = toProviderSubscription(
      fixture<StripeSubscription>('subscription.retrieval'),
    );

    it('reads the period from the subscription item, not the subscription', () => {
      // Stripe moved these onto the item; reading them from the subscription
      // would resolve to undefined and leave every period null.
      expect(fromRetrieval.currentPeriodStart).not.toBeNull();
      expect(fromRetrieval.currentPeriodEnd).not.toBeNull();
    });

    it('translates identity and status', () => {
      expect(fromRetrieval).toMatchObject({
        id: 'sub_1TyRotFaNFL0w4nvFNMuG7Dz',
        customerId: 'cus_UyObIRDznHwQ9E',
        priceId: 'price_1TyRojFaNFL0w4nvb4DY20uP',
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
      });
      expect(fromRetrieval.createdAt).not.toBeNull();
    });
  });

  describe('every field the translators read is on a delivered payload', () => {
    // The guard for the *class* of defect. `invoice.payments` resolved to
    // undefined on every delivery for as long as it was read, and nothing said
    // so — because a field that is merely absent looks exactly like a field
    // that is legitimately null. Stripe has many expandable sub-resources, and
    // the next one added here would fail the same way and just as quietly.
    //
    // So: every field the adapter reads off a provider object must be present
    // on the real delivered payload, or be listed below with a reason and a
    // statement of how it is obtained instead.

    /** Fields absent from deliveries, each with how the value is really got. */
    const KNOWN_ABSENT: Record<string, string> = {
      payments:
        'Expandable sub-resource, never on a delivery. Resolved through ' +
        'BillingProvider.getInvoice, which retrieves with expand: [payments].',
    };

    const adapterSource = readFileSync(
      join(__dirname, 'stripe-billing.provider.ts'),
      'utf8',
    );
    const adapter = codeOnly(adapterSource);

    function fieldsReadFrom(variable: string): string[] {
      const pattern = new RegExp(`\\b${variable}[.?]+([a-z_]+)`, 'g');
      return [...new Set([...adapter.matchAll(pattern)].map((m) => m[1]))];
    }

    it.each([
      ['invoice', 'invoice-paid.delivered-event', true],
      ['session', 'checkout-completed.delivered-event', true],
      ['subscription', 'subscription.retrieval', false],
    ])('%s', (variable, fixtureName, isDelivered) => {
      const payload = isDelivered
        ? delivered<Record<string, unknown>>(fixtureName)
        : fixture<Record<string, unknown>>(fixtureName);

      const missing = fieldsReadFrom(variable).filter(
        (field) => payload[field] === undefined && !(field in KNOWN_ABSENT),
      );

      expect(missing).toEqual([]);
    });

    it('still finds the one field that is genuinely absent', () => {
      // Guards the guard: if `payments` ever starts arriving on deliveries, or
      // stops being read, this allowlist entry is stale and should go — and
      // the reader should be told rather than left with a comment describing a
      // problem that no longer exists.
      const invoice = delivered<Record<string, unknown>>(
        'invoice-paid.delivered-event',
      );

      expect(Object.keys(KNOWN_ABSENT)).toEqual(['payments']);
      expect(invoice.payments).toBeUndefined();
      expect(adapter).toContain('invoice.payments');
      // And it is still obtained the way the allowlist claims it is.
      expect(adapterSource).toContain("expand: ['payments']");
    });
  });

  describe('checkoutCompletionOf', () => {
    it('translates a real completed one-time checkout', () => {
      // The add-on fulfilment path, against genuine output rather than a
      // hand-built literal.
      expect(
        checkoutCompletionOf(
          delivered<StripeSession>('checkout-completed.delivered-event'),
        ),
      ).toMatchObject({
        paymentIntentId: 'pi_3TyRt2FaNFL0w4nv14iLT1h7',
        amountTotal: 3000,
        currency: 'usd',
      });
    });
  });
});
