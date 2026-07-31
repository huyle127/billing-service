import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

/** The shortest password the service accepts (`user-auth` → "Weak password"). */
export const MINIMUM_PASSWORD_LENGTH = 8;

export class RegisterDto {
  @ApiProperty({ format: 'email', example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: MINIMUM_PASSWORD_LENGTH, example: 'correct-horse' })
  @IsString()
  @MinLength(MINIMUM_PASSWORD_LENGTH)
  password!: string;
}
