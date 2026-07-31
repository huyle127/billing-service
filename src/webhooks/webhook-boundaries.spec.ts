import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Properties of webhook processing that no behavioural test can observe:
 * which handler is allowed to allocate credit, and the absence of a local retry
 * mechanism. Both are claims about code that does *not* exist, so they are
 * asserted against the source in the same spirit as the SDK-confinement check.
 */

const SRC = join(__dirname, '..');

function typescriptFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === 'generated' ? [] : typescriptFilesUnder(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the webhook boundaries', () => {
  const sources = typescriptFilesUnder(SRC).map((file) => ({
    module: relative(SRC, file).split(sep).join('/'),
    source: readFileSync(file, 'utf8'),
  }));

  describe('Requirement: Handled Events Are Explicit', () => {
    it('Only invoice.paid allocates subscription credits', () => {
      const allocators = sources
        .filter(({ source }) => /allocateSubscriptionCredits\(/.test(source))
        .map(({ module }) => module)
        .sort();

      // The credits service defines it; the lifecycle transition, the paid
      // invoice handler, and the scheduled reset are the callers. The reset
      // joined this list in its own phase, deliberately — it is the second
      // allocation path the per-credit-period unique index exists to arbitrate.
      expect(allocators).toEqual([
        'credits/credits.service.ts',
        'reconciliation/credit-reset.job.ts',
        'subscriptions/subscription-lifecycle.service.ts',
        'webhooks/handlers/invoice-paid.handler.ts',
      ]);

      // No other webhook handler creates a subscription-sourced grant.
      const handlers = sources.filter(({ module }) =>
        module.startsWith('webhooks/handlers/'),
      );
      const granting = handlers
        .filter(({ source }) =>
          /allocateSubscriptionCredits\(|creditGrant\.create\(/.test(source),
        )
        .map(({ module }) => module);
      expect(granting).toEqual(['webhooks/handlers/invoice-paid.handler.ts']);
    });

    it('acts upon exactly the event types the adapter translates', () => {
      const adapter = sourceOf('provider/stripe-billing.provider.ts');
      const dispatch = sourceOf('webhooks/webhook.service.ts');

      // The one list of provider event types the service acts upon. Scoped to
      // the HANDLED_EVENT_TYPES declaration rather than scanning the whole
      // adapter: any other quoted argument in the file — a list filter, an API
      // parameter — is not an event type and must not be read as one.
      const declaration = /HANDLED_EVENT_TYPES = \{([^}]*)\}/.exec(adapter);
      expect(declaration).not.toBeNull();
      const translated = [
        ...declaration![1].matchAll(/^\s+\w+: '([\w.]+)',$/gm),
      ].map((match) => match[1]);
      // `checkout.session.completed` joined this list deliberately: it is what
      // fulfils a one-time add-on purchase. Before it was here, a paid add-on
      // was acknowledged as unhandled and its credits were never granted.
      // It allocates no *subscription* credit — the assertion above still holds.
      expect(translated.sort()).toEqual([
        'checkout.session.completed',
        'customer.subscription.deleted',
        'customer.subscription.updated',
        'invoice.paid',
        'invoice.payment_failed',
        'payment_method.attached',
        'payment_method.detached',
        'payment_method.updated',
      ]);

      // Each translated type becomes a kind, and each kind has a dispatch arm —
      // so adding one without handling it fails here rather than silently
      // becoming a no-op.
      const kinds = [
        ...sourceOf('provider/billing-provider.ts').matchAll(
          /kind: '([\w-]+)'/g,
        ),
      ].map((match) => match[1]);
      expect(kinds).toHaveLength(translated.length);
      for (const kind of kinds) {
        expect(dispatch).toContain(`case '${kind}':`);
      }
    });
  });

  describe('Requirement: Payment Failure Grace Period', () => {
    it('No local retry timer exists', () => {
      // Stripe owns the retry schedule and the final cancellation. Anything
      // here that armed a timer would be a second, competing schedule.
      const timers = sources
        .filter(({ source }) =>
          /\bsetTimeout\(|\bsetInterval\(|@Interval\(|@Timeout\(/.test(source),
        )
        .map(({ module }) => module);

      expect(timers).toEqual([]);
    });

    it('exposes no provider operation that retries a payment', () => {
      // Comments discuss retries at length; what matters is that no *operation*
      // offers one, so the prose is stripped before looking.
      const seam = withoutComments(sourceOf('provider/billing-provider.ts'));

      expect(seam).not.toMatch(/\b\w*(retry|retries|payInvoice)\w*\s*\(/i);
    });
  });

  function sourceOf(module: string): string {
    const found = sources.find((candidate) => candidate.module === module);
    if (!found) {
      throw new Error(`No source for ${module}`);
    }
    return found.source;
  }
});

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
