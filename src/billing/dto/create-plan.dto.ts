import { BillingCycle } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export class CreatePlanDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @Length(1, 64)
  code!: string;

  @IsString()
  @Length(1, 255)
  name!: string;

  @IsEnum(BillingCycle)
  cycle!: BillingCycle;

  @IsInt()
  @IsPositive()
  monthlyCredits!: number;

  @IsInt()
  @Min(0)
  amountCents!: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;
}
