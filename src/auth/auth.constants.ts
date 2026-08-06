import { Role } from '@prisma/client';

export const TOKEN_TYPES = {
  access: 'access',
  refresh: 'refresh',
} as const;

export type TokenType = (typeof TOKEN_TYPES)[keyof typeof TOKEN_TYPES];

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  tokenType: TokenType;
  jti?: string;
}
