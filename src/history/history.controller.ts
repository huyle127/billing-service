import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { ProductScopeService } from '../catalog/product-scope.service';
import { CreditHistoryService } from '../credits/credit-history.service';
import { CreditTransactionDto } from '../credits/dto/credits.dto';
import { PaymentsService } from '../payments/payments.service';
import { SubscriptionDto } from '../subscriptions/dto/subscription.dto';
import { SubscriptionHistoryService } from '../subscriptions/subscription-history.service';
import { PaymentDto } from './dto/history.dto';

/**
 * The three histories, in one place because a client asking "what happened to my
 * billing?" asks all three.
 *
 * Nothing here is a separate history table: subscription history is the sequence
 * of subscription rows, payment history is one row per attempt, and credit
 * history is the ledger. Each is a read of the same data the rest of the service
 * writes.
 */
@ApiTags('history')
@ApiBearerAuth()
@Controller('history')
export class HistoryController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly subscriptions: SubscriptionHistoryService,
    private readonly credits: CreditHistoryService,
    private readonly productScope: ProductScopeService,
  ) {}

  @Get('payments')
  @ApiOperation({
    summary: 'Every payment attempt, newest first',
    description:
      'Failed attempts are included: dunning is only observable locally ' +
      'because every attempt left a record.',
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: [PaymentDto] })
  async paymentHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<PaymentDto[]> {
    const productId = await this.productScope.resolveProductId(productKey);
    const rows = await this.payments.listPaymentHistory(user.userId, {
      productId,
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      amount: row.amount,
      currency: row.currency,
      subscriptionId: row.subscriptionId,
      addonPurchaseId: row.addonPurchaseId,
      providerInvoiceId: row.providerInvoiceId,
      attemptNumber: row.attemptNumber,
      failureReason: row.failureReason,
      createdAt: row.createdAt,
    }));
  }

  @Get('subscriptions')
  @ApiOperation({
    summary: 'Every subscription, current and terminal, oldest first',
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: [SubscriptionDto] })
  async subscriptionHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<SubscriptionDto[]> {
    const productId = await this.productScope.resolveProductId(productKey);
    const entries = await this.subscriptions.listSubscriptionHistory(
      user.userId,
      productId,
    );
    return entries.map(SubscriptionDto.fromHistory);
  }

  @Get('credits')
  @ApiOperation({
    summary: 'Every credit movement, newest first',
    description: 'The same ledger as `GET /credits/history`.',
  })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: [CreditTransactionDto] })
  async creditHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('productKey') productKey?: string,
  ): Promise<CreditTransactionDto[]> {
    const productId = await this.productScope.resolveProductId(productKey);
    const entries = await this.credits.listCreditHistory(
      user.userId,
      productId,
    );
    return entries.reverse();
  }
}
