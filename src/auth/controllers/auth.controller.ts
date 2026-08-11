import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { User } from '@prisma/client';
import { AuthenticatedUser } from '@/common/identity/authenticated-user';
import { CurrentUser } from '@/common/identity/current-user.decorator';
import { Public } from '@/common/identity/public.decorator';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RegisterDto } from '../dto/register.dto';
import { AuthService, TokenPair } from '../services/auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<User> {
    return this.auth.register(dto.email, dto.password);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.auth.logout(user.id);
  }
}
