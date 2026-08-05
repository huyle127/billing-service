import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfigModule } from '../../common/config/config.module';
import { configurations } from '../../common/config/configuration';
import { ValidationError } from '../../common/errors/domain.exception';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth.module';
import { AuthService } from './auth.service';

const PASSWORD = 'correct horse battery staple';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('the auth service', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let auth: AuthService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        AuthModule,
      ],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    auth = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  function anEmail(): string {
    return `${crypto.randomUUID()}@example.test`;
  }

  async function aRegisteredUser() {
    const email = anEmail();
    const user = await auth.register(email, PASSWORD);

    return { email, user };
  }

  it('stores a bcrypt hash and never the password', async () => {
    const { user } = await aRegisteredUser();
    const credential = await prisma.authCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });

    expect(user.role).toBe('USER');
    expect(credential.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(credential.passwordHash).not.toContain(PASSWORD);
    expect(credential.refreshToken).toBeNull();
  });

  it('leaves nothing behind when the same email registers twice', async () => {
    const { email } = await aRegisteredUser();

    await expect(auth.register(email, PASSWORD)).rejects.toThrow(ValidationError);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('stores the hash of the refresh token it hands out, not the token', async () => {
    const { email, user } = await aRegisteredUser();

    const tokens = await auth.login(email, PASSWORD);
    const credential = await prisma.authCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });

    expect(credential.refreshToken).toBe(sha256(tokens.refreshToken));
    expect(credential.refreshToken).not.toBe(tokens.refreshToken);
  });

  it('refuses a wrong password and an unknown email the same way', async () => {
    const { email } = await aRegisteredUser();

    await expect(auth.login(email, 'not the password')).rejects.toThrow('Invalid email or password');
    await expect(auth.login(anEmail(), PASSWORD)).rejects.toThrow('Invalid email or password');
  });

  it('rotates the refresh token, so the one it replaces stops working', async () => {
    const { email } = await aRegisteredUser();
    const first = await auth.login(email, PASSWORD);

    const second = await auth.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(auth.refresh(first.refreshToken)).rejects.toThrow('Invalid email or password');
    await expect(auth.refresh(second.refreshToken)).resolves.toBeDefined();
  });

  it('clears the stored hash on logout', async () => {
    const { email, user } = await aRegisteredUser();
    const tokens = await auth.login(email, PASSWORD);

    await auth.logout(user.id);

    const credential = await prisma.authCredential.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(credential.refreshToken).toBeNull();
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow('Invalid email or password');
  });
});
