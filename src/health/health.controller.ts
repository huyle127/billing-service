import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

export interface HealthResponse {
  status: 'ok';
  database: 'up';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Readiness as well as liveness: the service is only useful with a reachable
   * database, so an unreachable one surfaces as a failed health check rather
   * than as a healthy process that fails every request.
   */
  // Public: an orchestrator probing readiness holds no credentials, and a check
  // that needed a token would report "unhealthy" for an unauthenticated caller.
  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness and readiness' })
  async check(): Promise<HealthResponse> {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'up' };
  }
}
