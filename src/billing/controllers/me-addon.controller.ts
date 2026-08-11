import { Body, Controller, Post } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/identity/authenticated-user';
import { CurrentUser } from '../../common/identity/current-user.decorator';
import { PurchaseAddonDto } from '../dto/purchase-addon.dto';
import { AddonPurchaseService, PurchaseView } from '../services/addon-purchase.service';

@Controller('me/addons')
export class MeAddonController {
  constructor(private readonly purchases: AddonPurchaseService) {}

  @Post('purchase')
  purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PurchaseAddonDto,
  ): Promise<PurchaseView> {
    return this.purchases.purchase(user.id, dto);
  }
}
