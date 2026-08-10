import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service';
import { RequestWithService } from './service-principal';

export const INTERNAL_KEY_HEADER = 'x-internal-key';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class InternalKeyGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & RequestWithService>();
    const presented = request.headers[INTERNAL_KEY_HEADER];

    if (typeof presented !== 'string') throw new UnauthorizedException();
    if (!timingSafeEqual(digest(presented), digest(this.config.internalApiKey))) {
      throw new UnauthorizedException();
    }

    request.service = { kind: 'service' };

    return true;
  }
}
