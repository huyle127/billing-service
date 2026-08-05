import { describe, expect, it } from 'vitest';
import { InMemoryMetrics } from './in-memory-metrics';

describe('InMemoryMetrics', () => {
  it('counts each label set separately', () => {
    const metrics = new InMemoryMetrics();

    metrics.increment('credits.consume.declined', { reason: 'INSUFFICIENT_CREDITS' });
    metrics.increment('credits.consume.declined', { reason: 'INSUFFICIENT_CREDITS' });
    metrics.increment('credits.consume.declined', { reason: 'BILLING_FROZEN' });

    expect(metrics.valueOf('credits.consume.declined', { reason: 'INSUFFICIENT_CREDITS' })).toBe(2);
    expect(metrics.valueOf('credits.consume.declined', { reason: 'BILLING_FROZEN' })).toBe(1);
  });

  it('treats label order as irrelevant', () => {
    const metrics = new InMemoryMetrics();

    metrics.increment('x', { a: '1', b: '2' });
    metrics.increment('x', { b: '2', a: '1' });

    expect(metrics.valueOf('x', { a: '1', b: '2' })).toBe(2);
  });

  it('reports zero for a counter never touched', () => {
    expect(new InMemoryMetrics().valueOf('never.recorded')).toBe(0);
  });
});
