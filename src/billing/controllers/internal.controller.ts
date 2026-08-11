import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { InternalOnly } from '@/common/identity/internal-only.decorator';
import { RunRequestDto } from '../dto/run-request.dto';
import {
  AllocationRunSummary,
  AnnualAllocationService,
} from '../services/annual-allocation.service';
import { ProvisioningService, SweepSummary } from '../services/provisioning.service';

@Controller('internal')
@InternalOnly()
export class InternalController {
  constructor(
    private readonly allocation: AnnualAllocationService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Post('allocations/run')
  @HttpCode(HttpStatus.OK)
  runAllocations(@Body() _request: RunRequestDto): Promise<AllocationRunSummary> {
    return this.allocation.run();
  }

  @Post('provisioning/run')
  @HttpCode(HttpStatus.OK)
  runProvisioning(@Body() _request: RunRequestDto): Promise<SweepSummary> {
    return this.provisioning.sweep();
  }
}
