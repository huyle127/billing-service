import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppConfigService } from '../../common/config/app-config.service';
import { PROVISIONING_SWEEP } from '../billing.constants';
import { ProvisioningService } from './provisioning.service';

@Injectable()
export class ProvisioningSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvisioningSchedulerService.name);

  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly schedule: SchedulerRegistry,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.provisioningSweepIntervalMs;

    if (intervalMs === 0) return;

    this.schedule.addInterval(
      PROVISIONING_SWEEP,
      setInterval(() => void this.sweep(), intervalMs),
    );
  }

  onModuleDestroy(): void {
    if (!this.schedule.doesExist('interval', PROVISIONING_SWEEP)) return;

    this.schedule.deleteInterval(PROVISIONING_SWEEP);
  }

  private async sweep(): Promise<void> {
    await this.provisioning.sweep().catch((error: unknown) => {
      this.logger.error(
        `The provisioning sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
