export type MetricLabels = Record<string, string>;

export abstract class Metrics {
  abstract increment(name: string, labels?: MetricLabels): void;
}
