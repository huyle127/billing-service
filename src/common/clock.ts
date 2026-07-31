/**
 * The current time, as a dependency.
 *
 * The scheduled jobs are the one part of this service whose behaviour is a
 * function of *when* it runs, and the interesting assertions about them span
 * months: a Pro Annual subscription must produce twelve credit grants across a
 * year with no month skipped or doubled (design D7). A test cannot wait a year,
 * and sleeping is not an option, so the jobs read the time from here and a test
 * advances it.
 *
 * Note that this is the clock for *deciding what is due*, not for stamping
 * rows. Timestamps written to the database come from the database, so a
 * fast-forwarded test clock does not produce rows dated a year ahead.
 */

export const CLOCK = Symbol('CLOCK');

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock a test moves by hand. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date): void {
    this.current = new Date(at);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}
