import { IsInt, IsString, MaxLength, MinLength, NotEquals } from 'class-validator';

export class AdjustCreditsDto {
  @IsInt()
  @NotEquals(0)
  amount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  reason!: string;
}
