import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthenticatedUser, RequestWithUser } from './authenticated-user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser =>
    context.switchToHttp().getRequest<Required<RequestWithUser>>().user,
);
