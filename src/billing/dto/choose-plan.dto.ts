import { BillingCycle } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

export class ChoosePlanDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @Length(1, 64)
  planCode!: string;

  @IsEnum(BillingCycle)
  cycle!: BillingCycle;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  paymentMethodId?: string;
}
