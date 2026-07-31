import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Exempts a route from the global JWT guard.
 *
 * The guard is global and the exemptions are explicit, rather than the other way
 * round: a billing endpoint added without a decorator is protected by default,
 * where one that had to remember `@UseGuards` would be open by default
 * (`user-auth` → "JWT Authentication").
 *
 * Three routes carry it — register, login, and the provider's webhook, whose
 * trust model is its signature — plus the health check, which must answer before
 * anyone can authenticate.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
