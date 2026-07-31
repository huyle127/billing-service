import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ format: 'email', example: 'user@example.com' })
  @IsEmail()
  email!: string;

  /**
   * Deliberately not length-validated: a credential check must answer the same
   * way whatever was submitted, and a validation error on the login route would
   * distinguish "too short to be one of ours" from "wrong".
   */
  @ApiProperty({ example: 'correct-horse' })
  @IsString()
  password!: string;
}
