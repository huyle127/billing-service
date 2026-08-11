import { IsInt, IsOptional, IsPositive, IsString, Length, Min } from 'class-validator';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  monthlyCredits?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  amountCents?: number;
}
