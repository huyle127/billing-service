import { IsOptional, IsString } from 'class-validator';

export class AdminBillingQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;
}
