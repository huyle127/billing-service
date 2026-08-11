import { Controller, Get, Query } from '@nestjs/common';
import { AuthenticatedUser } from '@/common/identity/authenticated-user';
import { CurrentUser } from '@/common/identity/current-user.decorator';
import { HistoryQueryDto } from '../dto/history-query.dto';
import { HistoryPage, HistoryService } from '../services/history.service';

@Controller('me/history')
export class MeHistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  page(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: HistoryQueryDto,
  ): Promise<HistoryPage> {
    return this.history.page(user.id, {
      limit: query.limit,
      sources: query.type,
      from: query.from,
      cursor: query.cursor,
    });
  }
}
