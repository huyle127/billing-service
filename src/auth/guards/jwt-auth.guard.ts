import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { RequestWithUser } from '../../common/identity/authenticated-user';
import { IS_PUBLIC_KEY } from '../../common/identity/public.decorator';
import { JwtPayload, TOKEN_TYPES } from '../auth.constants';

const BEARER = 'Bearer';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & RequestWithUser>();
    const [scheme, token] = (request.headers.authorization ?? '').split(' ');

    if (scheme !== BEARER || !token) throw new UnauthorizedException();

    const payload = this.accessTokenPayload(token);
    request.user = { id: payload.sub, email: payload.email, role: payload.role };

    return true;
  }

  private accessTokenPayload(token: string): JwtPayload {
    try {
      const payload = this.jwt.verify<JwtPayload>(token);
      if (payload.tokenType !== TOKEN_TYPES.access) throw new Error('not an access token');

      return payload;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
