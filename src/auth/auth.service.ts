import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { ProductScopeService } from '../catalog/product-scope.service';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { isUniqueViolation } from '../common/prisma-errors';
import type { UserModel } from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from '../subscriptions/provisioning.service';
import type { AuthResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { jwtExpiresInFrom } from './jwt.config';
import type { JwtPayload } from './jwt.strategy';

/**
 * Work factor for password hashing. Ten is bcrypt's common default and is what
 * keeps a registration or login from taking long enough to matter.
 */
const BCRYPT_ROUNDS = 10;

/**
 * Registration, login, and token issuance.
 *
 * Two things it is careful about:
 *
 * - **The email conflict is decided by the database.** A prior lookup would lose
 *   the race between two concurrent registrations for the same address; the
 *   unique index is the arbiter and the violation is translated here.
 * - **Login answers identically for every failure.** An unknown address, a user
 *   with no password set, and a wrong password are one response, so the endpoint
 *   cannot be used to enumerate who holds an account.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly productScope: ProductScopeService,
    private readonly provisioning: ProvisioningService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    let user: UserModel;
    try {
      user = await this.prisma.user.create({
        data: { email: dto.email, passwordHash },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      throw new BillingException(
        ErrorCode.Conflict,
        'An account already exists for this email address.',
        HttpStatus.CONFLICT,
      );
    }

    await this.provisionFree(user.id);

    return this.issueToken(user);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Hashing against a throwaway value when no user matched would equalise the
    // timing; it is deliberately not done here, because the service is not
    // defending against a timing oracle and the extra work on every miss is a
    // cheap denial-of-service lever. The *response* is what stays identical.
    const verified =
      user?.passwordHash != null &&
      (await bcrypt.compare(dto.password, user.passwordHash));

    if (!verified || !user) {
      throw new BillingException(
        ErrorCode.Unauthenticated,
        'Those credentials are not valid.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    return this.issueToken(user);
  }

  /**
   * Registration triggers Free provisioning, which means a provider call and a
   * local row.
   *
   * Best-effort on purpose: provisioning talks to Stripe, and a provider outage
   * must not cost a user their account or their token. The
   * live-subscription-repair job exists precisely to give a user without a live
   * subscription their Free one, so a failure here is recoverable rather than
   * lost (AGENTS.md → Free Subscription).
   */
  private async provisionFree(userId: string): Promise<void> {
    try {
      const productId = await this.productScope.resolveProductId();
      await this.provisioning.provisionFreeSubscription(userId, productId);
    } catch (error) {
      this.logger.warn(
        `Free provisioning did not complete for new user ${userId}; the ` +
          `repair job will pick it up: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async issueToken(user: UserModel): Promise<AuthResponseDto> {
    const payload: JwtPayload = { sub: user.id, email: user.email };

    return {
      user: { id: user.id, email: user.email },
      accessToken: await this.jwt.signAsync(payload),
      expiresIn: String(jwtExpiresInFrom(this.config)),
    };
  }
}
