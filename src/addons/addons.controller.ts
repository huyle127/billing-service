import { Body, Controller, Get, Headers, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IDEMPOTENCY_KEY_HEADER } from '../common/constants';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { CatalogService } from '../catalog/catalog.service';
import { ProductScopeService } from '../catalog/product-scope.service';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import { AddonsService } from './addons.service';
import {
  AddonCheckoutDto,
  AddonPackageDto,
  PurchaseAddonDto,
} from './dto/addon.dto';

/**
 * Add-on purchases.
 *
 * The eligibility check happens in the service, before any provider call: a Free
 * user must not end up holding a checkout session for credit that would be
 * frozen the moment it arrived.
 */
@ApiTags('addons')
@ApiBearerAuth()
@Controller('addons')
export class AddonsController {
  constructor(
    private readonly addons: AddonsService,
    private readonly catalog: CatalogService,
    private readonly productScope: ProductScopeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the purchasable add-on packages' })
  @ApiQuery({ name: 'productKey', required: false })
  @ApiResponse({ status: 200, type: [AddonPackageDto] })
  async list(
    @Query('productKey') productKey?: string,
  ): Promise<AddonPackageDto[]> {
    const productId = await this.productScope.resolveProductId(productKey);
    const packages = await this.catalog.listAddonPackages(productId);

    return packages.map((addon) => ({
      id: addon.id,
      key: addon.key,
      name: addon.name,
      creditAmount: addon.creditAmount,
      unitAmount: addon.unitAmount,
      currency: addon.currency,
    }));
  }

  @Post()
  @ApiOperation({
    summary: 'Buy a credit add-on',
    description:
      'Creates a checkout session. Credit is granted only when the provider ' +
      'confirms payment, never from this request.',
  })
  @ApiResponse({ status: 201, type: AddonCheckoutDto })
  @ApiResponse({
    status: 404,
    description: 'NOT_FOUND — no such add-on SKU',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description:
      'INVALID_SUBSCRIPTION_STATE — add-ons need a live paid subscription',
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
  async purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PurchaseAddonDto,
    @Headers(IDEMPOTENCY_KEY_HEADER) idempotencyKey?: string,
  ): Promise<AddonCheckoutDto> {
    const productId = await this.productScope.resolveProductId(dto.productKey);

    return this.addons.initiatePurchase({
      userId: user.userId,
      productId,
      addonPackageKey: dto.addonPackageKey,
      idempotencyKey,
      successUrl: dto.successUrl,
      cancelUrl: dto.cancelUrl,
    });
  }
}
