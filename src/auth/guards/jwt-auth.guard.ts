import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthenticatedUser, JwtPayload, TOKEN_TYPES } from '../auth.constants';

const BEARER = 'Bearer';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
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
