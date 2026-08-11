import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from '@/common/identity/roles.decorator';
import { AdjustCreditsDto } from '../dto/adjust-credits.dto';
import { CreditService } from '../services/credit.service';
import { LedgerBalances } from '../services/draw-split';

@Controller('admin/users/:userId/credits')
@Roles(Role.ADMIN)
export class AdminCreditController {
  constructor(private readonly credit: CreditService) {}

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  adjust(
    @Param('userId') userId: string,
    @Body() dto: AdjustCreditsDto,
  ): Promise<LedgerBalances> {
    return this.credit.adjust(userId, dto.amount, dto.reason);
  }
}
