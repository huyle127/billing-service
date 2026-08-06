import { Role } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

export interface RequestWithUser {
  user?: AuthenticatedUser;
}
