import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../common/config/app-config.service';
import { UserModule } from '../user/user.module';
import { AuthController } from './controllers/auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthService } from './services/auth.service';

const ALGORITHM = 'HS256';

@Module({
  imports: [
    UserModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
        signOptions: { algorithm: ALGORITHM },
        verifyOptions: { algorithms: [ALGORITHM] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
