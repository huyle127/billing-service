import { ApiProperty } from '@nestjs/swagger';

export class CustomerDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({
    example: 'cus_1234567890',
    description: 'Created on first read if the user has none.',
  })
  stripeCustomerId!: string;
}
