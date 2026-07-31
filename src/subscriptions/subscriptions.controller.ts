import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { ProductScopeService } from '../catalog/product-scope.service';
import { IDEMPOTENCY_KEY_HEADER } from '../common/constants';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { BillingStateService } from './billing-state.service';
import {
  ChangeCycleDto,
  CheckoutSessionDto,
  CreateSubscriptionDto,
  SubscriptionDto,
} from './dto/subscription.dto';
import { SubscriptionHistoryService } from './subscription-history.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { SubscriptionLookupService } from './subscription-lookup.service';

/**
 * Subscription management.
 *
 * Every command names a subscription in the URL and is scoped to the caller
 * before anything else happens — the lifecycle service takes an id and does not
 * ask whose it is, so ownership is established here or not at all.
 *
 * The two cancellation modes are two routes on purpose (design D4a). One flag on
 * one route is how "cancel now" ends up cutting a paying user's entitlement
 * short by a billing period.
 */
@ApiTags('subscriptions')
@ApiBearerAuth()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly lifecycle: SubscriptionLifecycleService,
    private readonly lookup: SubscriptionLookupService,
    private readonly history: SubscriptionHistoryService,
    private readonly billingState: BillingStateService,
    private readonly productScope: ProductScopeService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List subscriptions, current and historical',
    description:
      'Plan changes create new rows rather than mutating existing ones, so the ' +
      'sequence of rows is the history. Terminal rows are included.',
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: [SubscriptionDto] })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<SubscriptionDto[]> {
    const productId = await this.productScope.resolveProductId(productKey);
    const entries = await this.history.listSubscriptionHistory(
      user.userId,
      productId,
    );
    return entries.map(SubscriptionDto.fromHistory);
  }

  @Get('current')
  @ApiOperation({
    summary: 'The live subscription for a product',
    description:
      'A pending period-end cancellation shows up as `cancelAtPeriodEnd`, not ' +
      'as a status and not as the user already being on Free.',
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: SubscriptionDto })
  @ApiResponse({
    status: 404,
    description: 'NOT_FOUND — no live subscription for this product',
    type: ErrorResponseDto,
  })
  async current(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<SubscriptionDto> {
    const productId = await this.productScope.resolveProductId(productKey);
    const state = await this.billingState.getBillingState(
      user.userId,
      productId,
    );

    if (!state.subscription) {
      // The transient window between one subscription leaving the live set and
      // its replacement entering it. Reported rather than papered over.
      throw new BillingException(
        ErrorCode.NotFound,
        'No live subscription for this product.',
        HttpStatus.NOT_FOUND,
      );
    }

    return SubscriptionDto.fromBillingState(state.subscription);
  }

  @Post()
  @ApiOperation({
    summary: 'Subscribe to or upgrade to the paid plan',
    description:
      'Creates a checkout session. No subscription row and no credit is ' +
      'written here — entitlement follows provider-confirmed payment.',
  })
  @ApiResponse({ status: 201, type: CheckoutSessionDto })
  @ApiResponse({
    status: 409,
    description: 'INVALID_SUBSCRIPTION_STATE — a live paid subscription exists',
    type: ErrorResponseDto,
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: false,
    description:
      'Identifies this attempt. Repeating a request with the same value ' +
      'returns the session the first one created instead of opening a second ' +
      'checkout. Omitting it means a retry is treated as a new request.',
  })
  async subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSubscriptionDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<CheckoutSessionDto> {
    const productId = await this.productScope.resolveProductId(dto.productKey);

    return this.lifecycle.createProCheckout({
      userId: user.userId,
      productId,
      billingInterval: dto.billingInterval,
      idempotencyKey,
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
    });
  }

  @Patch(':id/cycle')
  @ApiOperation({
    summary: 'Change the billing cycle',
    description:
      'A price change on the same provider subscription. Grants no credit and ' +
      'moves no credit-period boundary.',
  })
  @ApiResponse({ status: 200, type: SubscriptionDto })
  @ApiResponse({
    status: 400,
    description:
      'INVALID_PLAN_OR_CYCLE — the plan is not offered on that cycle',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_SUBSCRIPTION_STATE — not a live paid subscription',
    type: ErrorResponseDto,
  })
  async changeCycle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeCycleDto,
  ): Promise<SubscriptionDto> {
    await this.lookup.requireOwned(user.userId, id);
    await this.lifecycle.changeCycle(id, dto.billingInterval);
    return this.reload(user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel at period end',
    description:
      'Records the intent at the provider. The subscription stays live, keeps ' +
      'its plan, and keeps spending credit until the period ends. Reversible.',
  })
  @ApiResponse({ status: 200, type: SubscriptionDto })
  @ApiResponse({
    status: 409,
    description: 'INVALID_SUBSCRIPTION_STATE',
    type: ErrorResponseDto,
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SubscriptionDto> {
    await this.lookup.requireOwned(user.userId, id);
    await this.lifecycle.cancelAtPeriodEnd(id);
    return this.reload(user.userId, id);
  }

  @Post(':id/cancel-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel immediately',
    description:
      'Ends the paid subscription at once and provisions Free. Not reversible ' +
      'and issues no refund; money already collected is untouched.',
  })
  @ApiResponse({
    status: 200,
    type: SubscriptionDto,
    description: 'The Free subscription the user now holds.',
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_SUBSCRIPTION_STATE',
    type: ErrorResponseDto,
  })
  async cancelNow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SubscriptionDto> {
    await this.lookup.requireOwned(user.userId, id);
    const result = await this.lifecycle.cancelImmediately(id);
    return this.reload(user.userId, result.freeSubscription.id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear a pending period-end cancellation',
    description:
      'Applies only to a subscription that is still live. A subscription the ' +
      'provider has ended is never returned to the live set.',
  })
  @ApiResponse({ status: 200, type: SubscriptionDto })
  @ApiResponse({
    status: 409,
    description: 'INVALID_SUBSCRIPTION_STATE — nothing pending to clear',
    type: ErrorResponseDto,
  })
  async reactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SubscriptionDto> {
    await this.lookup.requireOwned(user.userId, id);
    await this.lifecycle.reactivate(id);
    return this.reload(user.userId, id);
  }

  /**
   * Re-reads the row through the history projection so every route answers with
   * the same shape, whatever the command returned.
   */
  private async reload(
    userId: string,
    subscriptionId: string,
  ): Promise<SubscriptionDto> {
    const subscription = await this.lookup.requireOwned(userId, subscriptionId);
    const entries = await this.history.listSubscriptionHistory(
      userId,
      subscription.productId,
    );
    const entry = entries.find((candidate) => candidate.id === subscriptionId);
    if (!entry) {
      throw new BillingException(
        ErrorCode.NotFound,
        'No such subscription.',
        HttpStatus.NOT_FOUND,
      );
    }
    return SubscriptionDto.fromHistory(entry);
  }
}
