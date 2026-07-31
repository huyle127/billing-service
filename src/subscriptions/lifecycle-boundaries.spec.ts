import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Properties of the lifecycle code that a behavioural test cannot observe.
 *
 * Two of the guarantees this phase rests on are structural: that no Stripe call
 * is issued from inside a database transaction, and that a Free Subscription row
 * is written from a known, small set of places. Both are invisible in a passing
 * happy-path suite — an implementation could open a transaction around a Stripe
 * call and still go green — so they are asserted against the source, in the same
 * spirit as the Stripe-SDK-confinement check in `provider-boundary.spec.ts`.
 *
 * These are lexical checks. They see a `$transaction` body, not everything it
 * transitively reaches, which is the honest limit of reading source rather than
 * instrumenting a driver.
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

function moduleName(file: string): string {
  return relative(SRC, file).split(sep).join('/');
}

/** Every `$transaction(...)` argument list in a file, balanced by parenthesis. */
function transactionBodies(source: string): string[] {
  const bodies: string[] = [];
  const opener = '$transaction(';

  for (
    let at = source.indexOf(opener);
    at !== -1;
    at = source.indexOf(opener, at + 1)
  ) {
    let depth = 0;
    const from = at + opener.length - 1;

    for (let cursor = from; cursor < source.length; cursor++) {
      if (source[cursor] === '(') {
        depth++;
      } else if (source[cursor] === ')') {
        depth--;
        if (depth === 0) {
          bodies.push(source.slice(from + 1, cursor));
          break;
        }
      }
    }
  }

  return bodies;
}

/** Calls to the provider seam, however the holding field is named. */
const PROVIDER_CALL = /\b(?:this\.)?(?:provider|billingProvider)\.\w+\(/;

describe('the subscription lifecycle boundaries', () => {
  const sources = typescriptFilesUnder(SRC).map((file) => ({
    module: moduleName(file),
    source: readFileSync(file, 'utf8'),
  }));

  describe('Requirement: Stripe Calls Are Never Inside A Database Transaction', () => {
    it('issues no provider call from inside a transaction', () => {
      const offenders = sources
        .flatMap(({ module, source }) =>
          transactionBodies(source).map((body) => ({ module, body })),
        )
        .filter(({ body }) => PROVIDER_CALL.test(body))
        .map(({ module }) => module);

      expect(offenders).toEqual([]);
    });

    it('finds the transaction bodies it is meant to be checking', () => {
      // Guards the check above against passing because the scan found nothing.
      const scanned = sources.flatMap(({ module, source }) =>
        transactionBodies(source).length > 0 ? [module] : [],
      );

      expect(scanned).toContain(
        'subscriptions/subscription-lifecycle.service.ts',
      );
      expect(scanned).toContain('credits/credits.service.ts');
    });
  });

  describe('Requirement: Free Provisioning Has Exactly Two Triggers', () => {
    it('No other flow provisions Free', () => {
      // A Subscription row is written in exactly one file. That used to be two
      // — `provisioning.service.ts` and `subscription-lifecycle.service.ts`,
      // each issuing its own `subscription.create` — and became one when the
      // write moved behind `SubscriptionRepository.insert`.
      //
      // Narrowing the writer set is the stronger half of the invariant. The
      // weaker half is that this check alone no longer says which *flows* can
      // provision Free, because a repository is callable from anywhere. The
      // `callers` assertion below is what carries that now, and it is the one
      // to extend deliberately when a new flow legitimately joins.
      const writers = sources.filter(({ source }) =>
        /subscription\.create\(/.test(source),
      );
      const callers = sources.filter(
        ({ module, source }) =>
          module !== 'subscriptions/provisioning.service.ts' &&
          /insertFreeSubscriptionRow\(|provisionFreeSubscription\(/.test(
            source,
          ),
      );

      expect(writers.map((w) => w.module).sort()).toEqual([
        'subscriptions/subscription.repository.ts',
      ]);
      expect(callers.map((c) => c.module).sort()).toEqual([
        // Registration, as §9 said it would.
        'auth/auth.service.ts',
        'reconciliation/live-subscription-repair.job.ts',
        'subscriptions/subscription-lifecycle.service.ts',
      ]);
    });

    it('routes every Subscription insert through the repository', () => {
      // The counterpart to narrowing `writers`: no service may reacquire a
      // direct `subscription.create` and slip past the repository.
      const direct = sources
        .filter(
          ({ module, source }) =>
            module !== 'subscriptions/subscription.repository.ts' &&
            /\b(?:tx|client|this\.prisma)\.subscription\.create\(/.test(source),
        )
        .map(({ module }) => module);

      expect(direct).toEqual([]);
    });

    it('is not reachable from a cancellation request', () => {
      const lifecycle = sources.find(
        (s) => s.module === 'subscriptions/subscription-lifecycle.service.ts',
      )!.source;

      // The only method that provisions Free is the provider-confirmed
      // transition. `cancelAtPeriodEnd` must not touch it, directly or by
      // calling the transition itself.
      const periodEndMode = methodBody(lifecycle, 'cancelAtPeriodEnd');
      expect(periodEndMode).not.toMatch(
        /prepareFreeSubscription|transitionProToFree/,
      );
      expect(methodBody(lifecycle, 'transitionProToFree')).toMatch(
        /prepareFreeSubscription/,
      );
    });
  });

  describe('Requirement: Two Distinct Cancellation Modes Are Offered', () => {
    it('keeps the two entry points distinct', () => {
      const lifecycle = sources.find(
        (s) => s.module === 'subscriptions/subscription-lifecycle.service.ts',
      )!.source;

      // Neither delegates to the other, and neither branches on a mode.
      expect(methodBody(lifecycle, 'cancelAtPeriodEnd')).not.toMatch(
        /cancelImmediately|cancelSubscriptionNow/,
      );
      expect(methodBody(lifecycle, 'cancelImmediately')).not.toMatch(
        /cancelAtPeriodEnd/,
      );
      // Each issues its own provider operation.
      expect(methodBody(lifecycle, 'cancelAtPeriodEnd')).toMatch(
        /cancelSubscriptionAtPeriodEnd/,
      );
      expect(methodBody(lifecycle, 'cancelImmediately')).toMatch(
        /cancelSubscriptionNow/,
      );
    });
  });
});

/** The body of a named method, up to the next method at the same indentation. */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`\n  async ${name}(`);
  if (start === -1) {
    throw new Error(`No method ${name} found`);
  }
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  for (let cursor = openingBrace; cursor < source.length; cursor++) {
    if (source[cursor] === '{') {
      depth++;
    } else if (source[cursor] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openingBrace, cursor);
      }
    }
  }
  throw new Error(`Unbalanced body for ${name}`);
}
