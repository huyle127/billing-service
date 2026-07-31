import { ApiProperty } from '@nestjs/swagger';
import type { PaymentStatus, PaymentType } from '../../generated/prisma/enums';

export class PaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['SUBSCRIPTION_RECURRING', 'ADDON_ONE_TIME'] })
  type!: PaymentType;

  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'] })
  status!: PaymentStatus;

  @ApiProperty({ description: 'Minor units.' })
  amount!: number;

  @ApiProperty({ example: 'usd' })
  currency!: string;

  @ApiProperty({ nullable: true, format: 'uuid' })
  subscriptionId!: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  addonPurchaseId!: string | null;

  @ApiProperty({ nullable: true })
  providerInvoiceId!: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Which attempt against the invoice this row records. A dunning cycle ' +
      'produces one row per attempt.',
  })
  attemptNumber!: number | null;

  @ApiProperty({ nullable: true })
  failureReason!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
