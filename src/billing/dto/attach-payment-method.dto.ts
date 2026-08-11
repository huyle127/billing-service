import { IsString, Length } from 'class-validator';

export class AttachPaymentMethodDto {
  @IsString()
  @Length(1, 255)
  paymentMethodId!: string;
}
