import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CheckoutUrlsDto } from '../../subscriptions/dto/subscription.dto';

export class PurchaseAddonDto extends CheckoutUrlsDto {
  @ApiProperty({
    example: 'credits-100',
    description: 'The catalogued add-on SKU.',
  })
  @IsString()
  @IsNotEmpty()
  addonPackageKey!: string;

  @ApiPropertyOptional({ description: 'Defaults to the AI product.' })
  @IsOptional()
  @IsString()
  productKey?: string;
}

export class AddonCheckoutDto {
  @ApiProperty({ format: 'uuid' })
  addonPurchaseId!: string;

  @ApiProperty({ example: 'cs_1234567890' })
  checkoutSessionId!: string;

  @ApiProperty({ nullable: true })
  url!: string | null;

  @ApiProperty({
    description:
      'What the purchase grants, read from the SKU rather than ' +
      'from the amount paid.',
  })
  creditAmount!: number;
}

export class AddonPackageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'credits-100' })
  key!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  creditAmount!: number;

  @ApiProperty({ description: 'Minor units.' })
  unitAmount!: number;

  @ApiProperty({ example: 'usd' })
  currency!: string;
}
