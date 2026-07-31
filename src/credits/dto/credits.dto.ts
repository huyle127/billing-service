import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import type {
  CreditGrantSource,
  CreditTransactionType,
} from '../../generated/prisma/enums';

export class ConsumeCreditsDto {
  @ApiProperty({ minimum: 1, example: 5 })
  @IsInt()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    description:
      "The caller's identifier for this consumption. Replaying a request with " +
      'the same value returns the original result rather than spending twice.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestId?: string;

  @ApiPropertyOptional({ description: 'Defaults to the AI product.' })
  @IsOptional()
  @IsString()
  productKey?: string;
}

export class CreditBalanceDto {
  @ApiProperty({ description: 'What can be spent right now.' })
  spendable!: number;

  @ApiProperty({
    description:
      'Credit the user owns but cannot currently spend. Preserved, not lost.',
  })
  frozen!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty({
    nullable: true,
    enum: ['PAST_DUE', 'NO_LIVE_SUBSCRIPTION'],
    description: 'Why consumption is refused, or null when it is not.',
  })
  freezeReason!: string | null;
}

export class ConsumptionEntryDto {
  @ApiProperty({ format: 'uuid' })
  grantId!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty()
  grantAmountRemainingAfter!: number;
}

export class ConsumeCreditsResultDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Groups the ledger rows of this movement.',
  })
  operationId!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ type: [ConsumptionEntryDto] })
  entries!: ConsumptionEntryDto[];

  @ApiProperty({
    description:
      'True when this request matched an already-recorded consumption.',
  })
  deduplicated!: boolean;
}

export class CreditTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  operationId!: string;

  @ApiProperty({ enum: ['ALLOCATION', 'CONSUMPTION', 'EXPIRY', 'ADJUSTMENT'] })
  type!: CreditTransactionType;

  @ApiProperty({
    description: 'Signed: positive allocates, negative consumes or expires.',
  })
  amount!: number;

  @ApiProperty({ format: 'uuid' })
  grantId!: string;

  @ApiProperty({ enum: ['SUBSCRIPTION', 'ADDON', 'ADJUSTMENT'] })
  grantSource!: CreditGrantSource;

  @ApiProperty()
  grantBalanceAfter!: number;

  @ApiProperty({
    description: 'Replayed from the ledger, not read from a column.',
  })
  balanceAfter!: number;

  @ApiProperty({ nullable: true })
  relatedEventType!: string | null;

  @ApiProperty({ nullable: true })
  relatedEventId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
