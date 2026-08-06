import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReverseCreditsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;
}
