import { Controller, Get, INestApplication, UseGuards, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmin } from '../prisma/seed-admin';
import { AuthModule } from '../src/auth/auth.module';
import { TOKEN_TYPES } from '../src/auth/auth.constants';
import { Roles } from '../src/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { AppConfigModule } from '../src/common/config/config.module';
import { AppConfigService } from '../src/common/config/app-config.service';
import { configurations } from '../src/common/config/configuration';
import { DomainExceptionFilter } from '../src/common/errors/domain-exception.filter';
import { AuthenticatedUser } from '../src/common/identity/authenticated-user';
import { CurrentUser } from '../src/common/identity/current-user.decorator';
import { PrismaModule } from '../src/common/prisma/prisma.module';
import { PrismaService } from '../src/common/prisma/prisma.service';

const PASSWORD = 'correct horse battery staple';

@Controller('probe')
class ProbeController {
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  admin(): { ok: true } {
    return { ok: true };
  }
}

describe('authentication over HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let jwt: JwtService;
  let config: AppConfigService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        AuthModule,
      ],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new DomainExceptionFilter());
    await app.listen(0);

    baseUrl = await app.getUrl();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService);
    config = moduleRef.get(AppConfigService);
  });

  afterAll(async () => {
    await app.close();
  });

  function anEmail(): string {
    return `${crypto.randomUUID()}@example.test`;
  }

  function post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  function get(path: string, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/v1${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  async function aLoggedInUser(): Promise<{ accessToken: string; refreshToken: string }> {
    const email = anEmail();
    await post('/auth/register', { email, password: PASSWORD });
    const response = await post('/auth/login', { email, password: PASSWORD });

    return response.json() as Promise<{ accessToken: string; refreshToken: string }>;
  }

  it('carries a user from register through login, refresh, and logout', async () => {
    const email = anEmail();

    const registered = await post('/auth/register', { email, password: PASSWORD });
    expect(registered.status).toBe(201);

    const login = await post('/auth/login', { email, password: PASSWORD });
    const tokens = (await login.json()) as { accessToken: string; refreshToken: string };
    expect(login.status).toBe(200);

    const me = await get('/probe/me', tokens.accessToken);
    expect((await me.json()).email).toBe(email);

    const refreshed = await post('/auth/refresh', { refreshToken: tokens.refreshToken });
    const rotated = (await refreshed.json()) as { refreshToken: string };
    expect(refreshed.status).toBe(200);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

    const loggedOut = await post('/auth/logout', {}, tokens.accessToken);
    expect(loggedOut.status).toBe(204);

    const afterLogout = await post('/auth/refresh', { refreshToken: rotated.refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it('refuses a second registration of the same email in the error envelope', async () => {
    const email = anEmail();
    await post('/auth/register', { email, password: PASSWORD });

    const second = await post('/auth/register', { email, password: PASSWORD });

    expect(second.status).toBe(400);
    expect((await second.json()).error.code).toBe('VALIDATION_FAILED');
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('rejects every shape of unusable access token with 401', async () => {
    const { accessToken, refreshToken } = await aLoggedInUser();
    const payload = { sub: 'user_1', email: 'a@example.test', role: Role.USER };

    const rejected = {
      absent: await get('/probe/me'),
      malformed: await get('/probe/me', 'not-a-jwt'),
      foreignSecret: await get(
        '/probe/me',
        new JwtService({ secret: 'a-different-secret' }).sign({
          ...payload,
          tokenType: TOKEN_TYPES.access,
        }),
      ),
      expired: await get(
        '/probe/me',
        jwt.sign({ ...payload, tokenType: TOKEN_TYPES.access }, { expiresIn: '-1s' }),
      ),
      wrongAlgorithm: await get(
        '/probe/me',
        new JwtService({
          secret: config.jwtSecret,
          signOptions: { algorithm: 'HS384' },
        }).sign({ ...payload, tokenType: TOKEN_TYPES.access }),
      ),
      refreshTyped: await get('/probe/me', refreshToken),
    };

    for (const [shape, response] of Object.entries(rejected)) {
      expect({ shape, status: response.status }).toEqual({ shape, status: 401 });
      expect({ shape, code: (await response.json()).error.code }).toEqual({
        shape,
        code: 'UNAUTHORIZED',
      });
    }

    expect((await get('/probe/me', accessToken)).status).toBe(200);
  });

  it('refuses an access token at the refresh endpoint', async () => {
    const { accessToken } = await aLoggedInUser();

    expect((await post('/auth/refresh', { refreshToken: accessToken })).status).toBe(401);
  });

  it('lets an admin token through and turns a user token away', async () => {
    await seedAdmin(prisma);
    const admin = await post('/auth/login', {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    const adminTokens = (await admin.json()) as { accessToken: string };
    const { accessToken: userToken } = await aLoggedInUser();

    expect((await get('/probe/admin', adminTokens.accessToken)).status).toBe(200);

    const forbidden = await get('/probe/admin', userToken);
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe('FORBIDDEN');

    expect((await get('/probe/admin')).status).toBe(401);
  });
});
