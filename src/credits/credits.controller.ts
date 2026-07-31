import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { ProductScopeService } from '../catalog/product-scope.service';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { SubscriptionLookupService } from '../subscriptions/subscription-lookup.service';
import { CreditHistoryService } from './credit-history.service';
import { CreditsService } from './credits.service';
import {
  ConsumeCreditsDto,
  ConsumeCreditsResultDto,
  CreditBalanceDto,
  CreditTransactionDto,
} from './dto/credits.dto';

/**
 * Credit balance, consumption, and history.
 *
 * Spendability is derived from the live subscription every time it is asked
 * for — there is no stored entitlement flag to read, and a frozen balance is
 * reported as frozen rather than as zero.
 */
@ApiTags('credits')
@ApiBearerAuth()
@Controller('credits')
export class CreditsController {
  constructor(
    private readonly credits: CreditsService,
    private readonly creditHistory: CreditHistoryService,
    private readonly subscriptions: SubscriptionLookupService,
    private readonly productScope: ProductScopeService,
  ) {}

  @Get('balance')
  @ApiOperation({
    summary: 'Spendable and frozen credit for a product',
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: CreditBalanceDto })
  async balance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<CreditBalanceDto> {
    const productId = await this.productScope.resolveProductId(productKey);
    const entitlement = await this.subscriptions.entitlementFor(
      user.userId,
      productId,
    );

    return this.credits.getBalance(user.userId, productId, entitlement);
  }

  @Post('consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Spend credit',
    description:
      'Drains grants in stored priority order. Idempotent against `requestId`: ' +
      'a replay returns the original movement instead of spending again.',
  })
  @ApiResponse({ status: 200, type: ConsumeCreditsResultDto })
  @ApiResponse({
    status: 402,
    description: 'INSUFFICIENT_CREDITS — including when the balance is frozen',
    type: ErrorResponseDto,
  })
  async consume(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConsumeCreditsDto,
  ): Promise<ConsumeCreditsResultDto> {
    const productId = await this.productScope.resolveProductId(dto.productKey);
    const entitlement = await this.subscriptions.entitlementFor(
      user.userId,
      productId,
    );

    return this.credits.consume({
      userId: user.userId,
      productId,
      // A caller that supplies none gets no replay protection, which is the
      // honest outcome: without a stable identifier there is nothing to match a
      // retry against.
      requestId: dto.requestId ?? randomUUID(),
      amount: dto.amount,
      entitlement,
    });
  }

  @Get('history')
  @ApiOperation({
    summary: 'Credit transactions for a product, newest first',
    description:
      "Each entry's running balance is replayed in ledger order and the result " +
      'is then reversed for presentation, so `balanceAfter` still means what it ' +
      "says. A period reset appears as the outgoing period's expiry followed " +
      "by the new period's allocation.",
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: [CreditTransactionDto] })
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<CreditTransactionDto[]> {
    const productId = await this.productScope.resolveProductId(productKey);
    const entries = await this.creditHistory.listCreditHistory(
      user.userId,
      productId,
    );

    // Reversed rather than queried descending: the running balance can only be
    // computed forwards, so the order is a presentation concern applied after.
    return entries.reverse();
  }
}
