import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

/**
 * What the JWT strategy puts on the request once a token verifies. Every billing
 * operation is scoped by `userId` taken from here — never from a request body or
 * a query parameter, which a caller could point at somebody else's account.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request>();
    return request.user as AuthenticatedUser;
  },
);
