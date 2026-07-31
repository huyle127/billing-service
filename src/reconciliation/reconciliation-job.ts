/**
 * The scheduled job set, and the contract every member of it satisfies.
 *
 * The set is declared here as data rather than left implicit in whichever
 * classes happen to carry a `@Cron` decorator, because "the jobs are exactly
 * these four" is a requirement (design D7, spec: *No Scheduled Job Retries A
 * Payment*) and a requirement about a set is only checkable if the set is
 * something a test can hold.
 *
 * What is deliberately absent is as load-bearing as what is present: there is
 * no payment-retry job, no period-advance job, and no cancel-on-a-timer job.
 * Stripe owns all three (C2). Adding one here would be the visible form of the
 * mistake C2 exists to prevent.
 */

export const RECONCILIATION_JOB_NAMES = [
  'credit-reset',
  'orphan-cleanup',
  'live-subscription-repair',
  'drift-detection',
] as const;

export type ReconciliationJobName = (typeof RECONCILIATION_JOB_NAMES)[number];

export interface ReconciliationJob<TReport> {
  readonly name: ReconciliationJobName;

  /**
   * Does the job's work once and reports what it did.
   *
   * Called directly by tests and by the `@Cron` entry point alike, so what runs
   * on a schedule is the same code path a test exercises — a job whose
   * scheduled wrapper did anything of its own would be untested in production
   * and untestable everywhere else.
   */
  run(): Promise<TReport>;
}

/**
 * How each job claims its work.
 *
 * Every claim is a key over `(entity, period)` enforced by a unique index —
 * never a "last run at" timestamp. That distinction is the whole of the
 * concurrency guarantee: two instances racing on the same period both attempt
 * the same key and the database picks one, whereas two instances comparing
 * wall-clock times both conclude the work is theirs and do it twice.
 *
 * Where a job's effect is *absorbing* — a cancelled subscription cannot be
 * cancelled again, a repaired user already has a live row — the period
 * degenerates to a single transition and the entity alone identifies the claim.
 */
export const JOB_CLAIM_KEYS: Readonly<Record<ReconciliationJobName, string>> = {
  'credit-reset': 'credit_grants (subscription_id, credit_period_start)',
  'orphan-cleanup': 'the provider subscription id; cancellation is absorbing',
  'live-subscription-repair':
    'subscriptions (user_id, product_id) partial unique over live statuses',
  'drift-detection': 'none — the job makes no state change',
};
