import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreditResetJob } from './credit-reset.job';
import { DriftDetectionJob } from './drift-detection.job';
import { LiveSubscriptionRepairJob } from './live-subscription-repair.job';
import { OrphanCleanupJob } from './orphan-cleanup.job';
import { JOB_CLAIM_KEYS, RECONCILIATION_JOB_NAMES } from './reconciliation-job';

/**
 * Source-level assertions about the scheduled job set, from
 * `specs/billing-reconciliation/spec.md`.
 *
 * Two of these are claims about code that must *not* exist — that the set stays
 * closed at four, and that none of them retries a payment. A claim of that
 * shape has no runtime behaviour to exercise, so the only place it can be
 * checked is the source itself.
 */

const RECONCILIATION_DIR = __dirname;
const SRC = join(__dirname, '..');

function sourcesIn(dir: string): { file: string; source: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((file) => ({
      file,
      source: readFileSync(join(dir, file), 'utf8'),
    }));
}

describe('the reconciliation boundaries', () => {
  describe('Requirement: No Scheduled Job Retries A Payment', () => {
    it('The job set is closed', () => {
      expect([...RECONCILIATION_JOB_NAMES].sort()).toEqual([
        'credit-reset',
        'drift-detection',
        'live-subscription-repair',
        'orphan-cleanup',
      ]);

      // The declared set and the classes that implement it agree. A fifth job
      // added as a class but not declared — or the reverse — fails here.
      const implemented = [
        new CreditResetJob(null!, null!, null!).name,
        new OrphanCleanupJob(null!, null!, null!).name,
        new LiveSubscriptionRepairJob(null!, null!).name,
        new DriftDetectionJob(null!, null!).name,
      ].sort();
      expect(implemented).toEqual([...RECONCILIATION_JOB_NAMES].sort());
    });

    it('every scheduled entry point belongs to one of the four', () => {
      // `@Cron` anywhere in the codebase is a scheduled job. Finding one
      // outside this directory would mean the set is no longer closed, and
      // finding one here in a file that is not a declared job would mean the
      // same.
      const scheduled = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
        .filter((f) => /@Cron\(/.test(readFileSync(join(SRC, f), 'utf8')))
        .map((f) => f.split(/[\\/]/).join('/'))
        .sort();

      expect(scheduled).toEqual([
        'reconciliation/credit-reset.job.ts',
        'reconciliation/drift-detection.job.ts',
        'reconciliation/live-subscription-repair.job.ts',
        'reconciliation/orphan-cleanup.job.ts',
      ]);
    });

    it('none of them retries a payment', () => {
      // C2: Stripe owns the retry schedule and the final cancellation. No job
      // may pay an invoice, retry one, or advance a billing period.
      const forbidden =
        /retryPayment|payInvoice|retryInvoice|advanceBillingPeriod|recordRecurringPayment/;

      for (const { file, source } of sourcesIn(RECONCILIATION_DIR)) {
        expect({ file, retries: forbidden.test(source) }).toEqual({
          file,
          retries: false,
        });
      }
    });
  });

  describe('Requirement: Scheduled Jobs Are Idempotent And Concurrency Safe', () => {
    it('Job anchors idempotency to a durable marker', () => {
      // Every job that changes state declares the `(entity, period)` key it
      // claims work by. Drift detection changes nothing and claims nothing.
      for (const name of RECONCILIATION_JOB_NAMES) {
        expect(JOB_CLAIM_KEYS[name]).toBeTruthy();
      }
      expect(JOB_CLAIM_KEYS['drift-detection']).toMatch(/no state change/);

      // No job decides what work is its own by comparing a stored "last run"
      // timestamp against the wall clock — the pattern that makes two instances
      // both conclude the work is theirs.
      for (const { file, source } of sourcesIn(RECONCILIATION_DIR)) {
        expect({
          file,
          usesLastRun: /lastRunAt|lastExecutedAt/.test(source),
        }).toEqual({ file, usesLastRun: false });
      }
    });
  });

  describe('Requirement: Scheduled Credit Reset Is Required', () => {
    it('Reset job shares the allocation routine', () => {
      const reset = readFileSync(
        join(RECONCILIATION_DIR, 'credit-reset.job.ts'),
        'utf8',
      );
      const invoiceHandler = readFileSync(
        join(SRC, 'webhooks/handlers/invoice-paid.handler.ts'),
        'utf8',
      );

      // Both allocate through the one routine, keyed by subscription and
      // credit-period start.
      for (const source of [reset, invoiceHandler]) {
        expect(/allocateSubscriptionCredits\(/.test(source)).toBe(true);
        expect(/creditPeriodStart:/.test(source)).toBe(true);
      }

      // And neither creates a grant by any other means, which is what stops one
      // path from acquiring an allocation the other cannot see.
      for (const source of [reset, invoiceHandler]) {
        expect(/creditGrant\.create\(/.test(source)).toBe(false);
      }

      // Neither needs to know whether the other has run: no reference to the
      // other path appears in the *code* of either. Prose may mention it — the
      // reason each path can ignore the other is worth explaining where it
      // holds — so both comment forms are stripped before looking.
      const resetCode = reset
        .replace(/^\s*(\*|\/\/).*$/gm, '')
        .replace(/^\s*\/\*\*?.*$/gm, '');
      expect(/invoice/i.test(resetCode)).toBe(false);
      expect(/creditReset|CreditResetJob/.test(invoiceHandler)).toBe(false);
    });
  });

  describe('Requirement: Local State Drift From Stripe Is Detected', () => {
    it('Drift detection makes no Stripe mutations', () => {
      const source = readFileSync(
        join(RECONCILIATION_DIR, 'drift-detection.job.ts'),
        'utf8',
      );

      // The only provider call it may make is a read. Mutating methods of the
      // seam must not appear at all.
      const mutations = [
        'createSubscription',
        'changeSubscriptionPrice',
        'cancelSubscriptionAtPeriodEnd',
        'cancelSubscriptionNow',
        'reactivateSubscription',
        'createCheckoutSession',
        'createCustomer',
      ].filter((method) => new RegExp(`provider\\.${method}\\(`).test(source));

      expect(mutations).toEqual([]);
      expect(/provider\.getSubscription\(/.test(source)).toBe(true);
    });
  });
});
