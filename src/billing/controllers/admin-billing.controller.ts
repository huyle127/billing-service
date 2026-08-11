import { Controller, Get, Param } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '../../common/identity/roles.decorator';
import { AdminBillingView, AdminBillingViewService } from '../services/admin-billing-view.service';

@Controller('admin/users/:userId/billing')
@Roles(Role.ADMIN)
export class AdminBillingController {
  constructor(private readonly view: AdminBillingViewService) {}

  @Get()
  of(@Param('userId') userId: string): Promise<AdminBillingView> {
    return this.view.of(userId);
  }
}
