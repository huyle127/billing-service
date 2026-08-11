import { Controller, Get, Param, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/identity/roles.decorator';
import { AdminBillingQueryDto } from '../dto/admin-billing-query.dto';
import { AdminBillingView, AdminBillingViewService } from '../services/admin-billing-view.service';

@Controller('admin/users/:userId/billing')
@Roles(Role.ADMIN)
export class AdminBillingController {
  constructor(private readonly view: AdminBillingViewService) {}

  @Get()
  of(
    @Param('userId') userId: string,
    @Query() query: AdminBillingQueryDto,
  ): Promise<AdminBillingView> {
    return this.view.of(userId, query.cursor);
  }
}
