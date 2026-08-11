import { IsString, Length, Matches } from 'class-validator';

export class PurchaseAddonDto {
  @IsString()
  @Matches(/^[a-z0-9_]+$/)
  @Length(1, 64)
  packageCode!: string;
}
