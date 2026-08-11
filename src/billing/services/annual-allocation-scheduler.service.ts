import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AppConfigService } from '@/common/config/app-config.service';
import { ANNUAL_ALLOCATION_SWEEP } from '../billing.constants';
import { AnnualAllocationService } from './annual-allocation.service';

@Injectable()
export class AnnualAllocationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnnualAllocationSchedulerService.name);

  constructor(
    private readonly allocation: AnnualAllocationService,
    private readonly schedule: SchedulerRegistry,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const job = new CronJob(this.config.allocationCron, () => void this.run());

    this.schedule.addCronJob(ANNUAL_ALLOCATION_SWEEP, job);
    job.start();
  }

  onModuleDestroy(): void {
    if (!this.schedule.doesExist('cron', ANNUAL_ALLOCATION_SWEEP)) return;

    this.schedule.deleteCronJob(ANNUAL_ALLOCATION_SWEEP);
  }

  private async run(): Promise<void> {
    await this.allocation.run().catch((error: unknown) => {
      this.logger.error(
        `The annual allocation run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
