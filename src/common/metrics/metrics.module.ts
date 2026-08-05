import { Global, Module } from '@nestjs/common';
import { InMemoryMetrics } from './in-memory-metrics';
import { Metrics } from './metrics';

@Global()
@Module({
  providers: [InMemoryMetrics, { provide: Metrics, useExisting: InMemoryMetrics }],
  exports: [Metrics, InMemoryMetrics],
})
export class MetricsModule {}
