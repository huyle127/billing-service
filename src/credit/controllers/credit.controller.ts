import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthenticatedUser } from '@/common/identity/authenticated-user';
import { CurrentUser } from '@/common/identity/current-user.decorator';
import { ConsumeCreditsDto } from '../dto/consume-credits.dto';
import { ReverseCreditsDto } from '../dto/reverse-credits.dto';
import { ConsumeResult, CreditService, ReverseResult } from '../services/credit.service';

@Controller('credits')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Post('consume')
  @HttpCode(HttpStatus.OK)
  consume(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConsumeCreditsDto,
  ): Promise<ConsumeResult> {
    return this.credit.consume(user.id, dto);
  }

  @Post('reverse')
  @HttpCode(HttpStatus.OK)
  reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReverseCreditsDto,
  ): Promise<ReverseResult> {
    return this.credit.reverse(user.id, dto.idempotencyKey);
  }
}
