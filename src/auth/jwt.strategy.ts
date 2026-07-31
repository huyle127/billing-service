import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser } from './current-user.decorator';
import { jwtSecretFrom } from './jwt.config';

/** The claims this service puts in a token, and the only ones it reads back. */
export interface JwtPayload {
  /** The local user id. */
  sub: string;
  email: string;
}

/**
 * Verifies signature, expiry, and structure. `ignoreExpiration: false` is
 * spelled out rather than left to the default, because an expired token being
 * accepted is exactly the failure this phase's spec calls out.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecretFrom(config),
    });
  }

  /**
   * Runs only once the token has verified. The user id travels no further than
   * the request object, and every downstream operation is scoped by it.
   */
  validate(payload: JwtPayload): AuthenticatedUser {
    return { userId: payload.sub, email: payload.email };
  }
}
