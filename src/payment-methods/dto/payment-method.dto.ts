import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import type { PaymentMethodModel } from '../../generated/prisma/models';

/**
 * What the API returns for a mirrored payment method.
 *
 * There is no field here for a card number or a security code, and there is
 * nowhere upstream one could come from: the service is only ever given a
 * provider identifier (`payment-method-mirror` → "No card data stored").
 */
export class PaymentMethodDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: "The provider's identifier for this method." })
  providerPaymentMethodId!: string;

  @ApiProperty({ nullable: true, example: 'visa' })
  brand!: string | null;

  @ApiProperty({ nullable: true, example: '4242' })
  last4!: string | null;

  @ApiProperty({ nullable: true, example: 12 })
  expMonth!: number | null;

  @ApiProperty({ nullable: true, example: 2030 })
  expYear!: number | null;

  @ApiProperty({
    description:
      'Whether the provider charges this method. Mirrored from the provider, ' +
      'and at most one per user.',
  })
  isDefault!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  // `this: void` because this is passed to `.map()` as a bare reference. It
  // reads only its argument, so the annotation is accurate and it lets callers
  // detach it from the class.
  static from(this: void, model: PaymentMethodModel): PaymentMethodDto {
    return {
      id: model.id,
      providerPaymentMethodId: model.providerPaymentMethodId,
      brand: model.brand,
      last4: model.last4,
      expMonth: model.expMonth,
      expYear: model.expYear,
      isDefault: model.isDefault,
      createdAt: model.createdAt,
    };
  }
}

export class AttachPaymentMethodDto {
  @ApiProperty({
    example: 'pm_1234567890',
    description:
      "The provider's identifier for a method the client has already " +
      'collected. Card details are collected by the provider, never by this ' +
      'service.',
  })
  @IsString()
  @IsNotEmpty()
  paymentMethodId!: string;
}
