import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../common/config/app-config.service';
import { PROVISIONING_SWEEP } from '../billing.constants';
import { ProvisioningSchedulerService } from './provisioning-scheduler.service';
import { ProvisioningService } from './provisioning.service';

const INTERVAL_MS = 1000;

describe('the provisioning schedule', () => {
  function aScheduler(
    provisioningSweepIntervalMs: number,
    sweep: () => Promise<void>,
  ): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        ProvisioningSchedulerService,
        { provide: ProvisioningService, useValue: { sweep } },
        { provide: AppConfigService, useValue: { provisioningSweepIntervalMs } },
      ],
    }).compile();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers nothing when the interval is zero', async () => {
    const moduleRef = await aScheduler(0, () => Promise.resolve());

    await moduleRef.init();

    expect(moduleRef.get(SchedulerRegistry).getIntervals()).toEqual([]);

    await moduleRef.close();
  });

  it('registers one interval whose firing reaches the same sweep a caller reaches', async () => {
    const swept = vi.fn(() => Promise.resolve());
    const moduleRef = await aScheduler(INTERVAL_MS, swept);

    vi.useFakeTimers();
    await moduleRef.init();

    expect(moduleRef.get(SchedulerRegistry).getIntervals()).toEqual([PROVISIONING_SWEEP]);

    vi.advanceTimersByTime(INTERVAL_MS);

    expect(swept).toHaveBeenCalledOnce();

    vi.useRealTimers();
    await moduleRef.close();

    expect(moduleRef.get(SchedulerRegistry).getIntervals()).toEqual([]);
  });
});
