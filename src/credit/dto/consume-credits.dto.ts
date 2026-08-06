import { IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';

export class ConsumeCreditsDto {
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
