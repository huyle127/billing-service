import { Injectable } from '@nestjs/common';
import { MetricLabels, Metrics } from './metrics';

function serialise(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return entries ? `${name}{${entries}}` : name;
}

@Injectable()
export class InMemoryMetrics extends Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, labels: MetricLabels = {}): void {
    const key = serialise(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  valueOf(name: string, labels: MetricLabels = {}): number {
    return this.counters.get(serialise(name, labels)) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  reset(): void {
    this.counters.clear();
  }
}
