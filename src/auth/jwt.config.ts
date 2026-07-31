import { ConfigService } from '@nestjs/config';
import type { JwtSignOptions } from '@nestjs/jwt';

/**
 * What the signer accepts for a lifetime: seconds, or a duration string such as
 * `15m`. The signing library narrows the string side to a template literal
 * union, which an environment variable cannot satisfy without a cast.
 */
export type JwtExpiry = NonNullable<JwtSignOptions['expiresIn']>;

/**
 * How the signing secret and token lifetime are resolved, in one place, so the
 * strategy that verifies a token and the module that signs one cannot disagree
 * about either.
 */

/**
 * Used only when `JWT_SECRET` is unset outside production. A fixed fallback is
 * what makes `npm test` and a fresh checkout work without ceremony; it is
 * refused in production rather than allowed to become a deployed secret.
 */
export const DEVELOPMENT_JWT_SECRET = 'development-only-jwt-secret';

/**
 * Short by design: this phase issues no refresh tokens, so an access token is
 * the whole session and a long one is a long-lived bearer credential (design
 * risk "JWT expiration and refresh").
 */
export const DEFAULT_JWT_EXPIRES_IN: JwtExpiry = '15m';

export function jwtSecretFrom(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  if (secret) {
    return secret;
  }

  if (config.get<string>('NODE_ENV') === 'production') {
    throw new Error(
      'JWT_SECRET must be set in production. Tokens signed with the ' +
        'development fallback would be forgeable by anyone holding this source.',
    );
  }

  return DEVELOPMENT_JWT_SECRET;
}

export function jwtExpiresInFrom(config: ConfigService): JwtExpiry {
  const configured = config.get<string>('JWT_EXPIRES_IN');
  // The cast is the whole reason this function exists: a bad value fails once,
  // loudly, at signing time rather than being spread across call sites.
  return configured ? (configured as JwtExpiry) : DEFAULT_JWT_EXPIRES_IN;
}
