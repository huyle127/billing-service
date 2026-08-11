import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfigService } from '@/common/config/app-config.service';
import { CATALOG_MIGRATION_SWEEP } from '../billing.constants';
import { CatalogReconcilerService } from './catalog-reconciler.service';

@Injectable()
export class CatalogReconcilerSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogReconcilerSchedulerService.name);

  constructor(
    private readonly reconciler: CatalogReconcilerService,
    private readonly schedule: SchedulerRegistry,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.catalogCron, () => void this.run());

    this.schedule.addCronJob(CATALOG_MIGRATION_SWEEP, job);
    job.start();
  }

  onModuleDestroy(): void {
    if (!this.schedule.doesExist('cron', CATALOG_MIGRATION_SWEEP)) return;

    this.schedule.deleteCronJob(CATALOG_MIGRATION_SWEEP);
  }

  private async run(): Promise<void> {
    await this.reconciler.run().catch((error: unknown) => {
      this.logger.error(
        `The catalog migration run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
