import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/current-user.decorator';
import { ErrorResponseDto } from '../common/errors/error-response.dto';
import {
  AttachPaymentMethodDto,
  PaymentMethodDto,
} from './dto/payment-method.dto';
import { PaymentMethodsService } from './payment-methods.service';

@ApiTags('payment-methods')
@ApiBearerAuth()
@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly paymentMethods: PaymentMethodsService) {}

  @Get()
  @ApiOperation({
    summary: "List the user's payment methods",
    description:
      'Reads the local mirror of what the provider holds. Descriptors only — ' +
      'no card data is stored or returned.',
  })
  @ApiResponse({ status: 200, type: [PaymentMethodDto] })
  async list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentMethodDto[]> {
    const methods = await this.paymentMethods.list(user.userId);
    return methods.map(PaymentMethodDto.from);
  }

  @Post()
  @ApiOperation({
    summary: 'Attach a payment method',
    description:
      'Attaches a method the client has already collected at the provider. ' +
      'The mirror is written from the provider response, never before it.',
  })
  @ApiResponse({ status: 201, type: PaymentMethodDto })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_FAILED or INVALID_PAYMENT_METHOD',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 502,
    description: 'MISSING_STRIPE_CUSTOMER or STRIPE_API_ERROR',
    type: ErrorResponseDto,
  })
  async attach(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AttachPaymentMethodDto,
  ): Promise<PaymentMethodDto> {
    const attached = await this.paymentMethods.attach(
      user.userId,
      dto.paymentMethodId,
    );
    return PaymentMethodDto.from(attached);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Detach a payment method',
    description:
      'Detaches at the provider and then drops the mirror row. Accepts either ' +
      "the mirror id or the provider's payment method id.",
  })
  @ApiParam({ name: 'id', description: 'Mirror id or provider identifier.' })
  @ApiResponse({ status: 204, description: 'Detached.' })
  @ApiResponse({
    status: 400,
    description: 'INVALID_PAYMENT_METHOD — no such method for this user',
    type: ErrorResponseDto,
  })
  detach(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    return this.paymentMethods.detach(user.userId, id);
  }

  @Patch(':id/default')
  @ApiOperation({
    summary: 'Make a payment method the default',
    description:
      'Sets the default at the provider — which is what decides future ' +
      'charges — and refreshes the mirror to match.',
  })
  @ApiParam({ name: 'id', description: 'Mirror id or provider identifier.' })
  @ApiResponse({ status: 200, type: PaymentMethodDto })
  @ApiResponse({
    status: 400,
    description: 'INVALID_PAYMENT_METHOD — no such method for this user',
    type: ErrorResponseDto,
  })
  async setDefault(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<PaymentMethodDto> {
    const method = await this.paymentMethods.setDefault(user.userId, id);
    return PaymentMethodDto.from(method);
  }
}
