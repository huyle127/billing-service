import { ApiProperty } from '@nestjs/swagger';

export class AuthenticatedUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;
}

/** What registration and login both return: the user, and a bearer token. */
export class AuthResponseDto {
  @ApiProperty({ type: AuthenticatedUserDto })
  user!: AuthenticatedUserDto;

  @ApiProperty({
    description: 'A JWT to send as `Authorization: Bearer <token>`.',
  })
  accessToken!: string;

  @ApiProperty({
    example: '15m',
    description: 'How long the token stays valid.',
  })
  expiresIn!: string;
}
