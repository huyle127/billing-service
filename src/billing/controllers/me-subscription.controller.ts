import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/identity/authenticated-user';
import { CurrentUser } from '../../common/identity/current-user.decorator';
import { ChoosePlanDto } from '../dto/choose-plan.dto';
import { MeSubscriptionService, MeSubscriptionView } from '../services/me-subscription.service';

@Controller('me/subscription')
export class MeSubscriptionController {
  constructor(private readonly subscriptions: MeSubscriptionService) {}

  @Get()
  view(@CurrentUser() user: AuthenticatedUser): Promise<MeSubscriptionView> {
    return this.subscriptions.view(user.id);
  }

  @Post()
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChoosePlanDto,
  ): Promise<MeSubscriptionView> {
    return this.subscriptions.subscribe(user.id, dto);
  }

  @Patch()
  change(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChoosePlanDto,
  ): Promise<MeSubscriptionView> {
    return this.subscriptions.change(user.id, dto);
  }

  @Delete()
  cancel(@CurrentUser() user: AuthenticatedUser): Promise<MeSubscriptionView> {
    return this.subscriptions.cancel(user.id);
  }
}
