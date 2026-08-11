import { Controller, Get } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/identity/authenticated-user';
import { CurrentUser } from '../../common/identity/current-user.decorator';
import { CreditService, WalletView } from '../services/credit.service';

@Controller('me/wallet')
export class MeWalletController {
  constructor(private readonly credit: CreditService) {}

  @Get()
  view(@CurrentUser() user: AuthenticatedUser): Promise<WalletView> {
    return this.credit.wallet(user.id);
  }
}
