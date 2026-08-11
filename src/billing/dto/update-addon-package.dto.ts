import { IsInt, IsOptional, IsPositive, IsString, Length, Min } from 'class-validator';

export class UpdateAddonPackageDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  credits?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  amountCents?: number;
}
