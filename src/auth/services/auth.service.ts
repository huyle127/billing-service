import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import { compare, hash } from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import { REGISTRATION_TRANSACTION } from '@/billing/billing.constants';
import { EntitlementService } from '@/billing/services/entitlement.service';
import { ProvisioningService } from '@/billing/services/provisioning.service';
import { AppConfigService } from '@/common/config/app-config.service';
import { ValidationError } from '@/common/errors/domain.exception';
import { PrismaService } from '@/common/prisma/prisma.service';
import { UserService } from '@/user/services/user.service';
import { JwtPayload, TOKEN_TYPES, TokenType } from '../auth.constants';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isDuplicateEmail(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly entitlement: EntitlementService,
    private readonly provisioning: ProvisioningService,
  ) {}

  async register(email: string, password: string): Promise<User> {
    const passwordHash = await hash(password, this.config.bcryptSaltRounds);
    const user = await this.createWithEntitlement(email, passwordHash);

    void this.provisioning.provision(user.id).catch(() => undefined);

    return user;
  }

  private async createWithEntitlement(email: string, passwordHash: string): Promise<User> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await this.users.createInTransaction(tx, { email });
        await tx.authCredential.create({ data: { userId: user.id, passwordHash } });
        await this.entitlement.grantOnRegistration(tx, user);

        return user;
      }, REGISTRATION_TRANSACTION);
    } catch (error) {
      if (isDuplicateEmail(error)) {
        throw new ValidationError('Email is already registered', { email });
      }
      throw error;
    }
  }

  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmail(email);
    const credential = user
      ? await this.prisma.authCredential.findUnique({ where: { userId: user.id } })
      : null;

    if (!user || !credential || !(await compare(password, credential.passwordHash))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return this.issuePair(user);
  }

  async refresh(token: string): Promise<TokenPair> {
    const payload = this.verify(token, TOKEN_TYPES.refresh);
    const credential = await this.prisma.authCredential.findUnique({
      where: { userId: payload.sub },
    });

    if (!credential || credential.refreshToken !== hashRefreshToken(token)) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    return this.issuePair(user);
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.authCredential.update({
      where: { userId },
      data: { refreshToken: null },
    });
  }

  private async issuePair(user: User): Promise<TokenPair> {
    const accessToken = this.sign(user, TOKEN_TYPES.access, this.config.accessTokenTtl);
    const refreshToken = this.sign(
      user,
      TOKEN_TYPES.refresh,
      this.config.refreshTokenTtl,
      randomUUID(),
    );

    await this.prisma.authCredential.update({
      where: { userId: user.id },
      data: { refreshToken: hashRefreshToken(refreshToken) },
    });

    return { accessToken, refreshToken };
  }

  private sign(user: User, tokenType: TokenType, expiresIn: string, jti?: string): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenType,
      jti,
    };

    return this.jwt.sign(payload, { expiresIn: expiresIn as JwtSignOptions['expiresIn'] });
  }

  private verify(token: string, expected: TokenType): JwtPayload {
    try {
      const payload = this.jwt.verify<JwtPayload>(token);
      if (payload.tokenType !== expected) throw new Error('unexpected token type');

      return payload;
    } catch {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
  }
}
