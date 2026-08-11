import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { AuthenticatedUser } from '../../common/identity/authenticated-user';
import { CurrentUser } from '../../common/identity/current-user.decorator';
import { AttachPaymentMethodDto } from '../dto/attach-payment-method.dto';
import { PaymentMethodService, PaymentMethodView } from '../services/payment-method.service';

@Controller('me/payment-methods')
export class MePaymentMethodController {
  constructor(private readonly methods: PaymentMethodService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PaymentMethodView[]> {
    return this.methods.list(user.id);
  }

  @Post()
  attach(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AttachPaymentMethodDto,
  ): Promise<PaymentMethodView> {
    return this.methods.attach(user.id, dto.paymentMethodId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  detach(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    return this.methods.detach(user.id, id);
  }
}
