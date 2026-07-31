import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Observable } from 'rxjs';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * The global authentication guard.
 *
 * Registered as an `APP_GUARD`, so protection is the default and exemption is a
 * decorator. Passport's own failure is translated into the service's error shape
 * here, because a caller must not be able to tell a malformed token from an
 * expired one from an unknown user — all four failure modes in `user-auth` →
 * "JWT Authentication" are one answer: UNAUTHENTICATED.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    return isPublic ? true : super.canActivate(context);
  }

  handleRequest<TUser>(error: unknown, user: TUser): TUser {
    if (error || !user) {
      throw new BillingException(
        ErrorCode.Unauthenticated,
        'A valid bearer token is required for this endpoint.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return user;
  }
}
