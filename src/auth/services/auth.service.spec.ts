import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FREE_PLAN } from '../../billing/billing.constants';
import { FakeStripeAdapter } from '../../billing/stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../../billing/stripe/interfaces/stripe-adapter.interface';
import { STRIPE_OPERATIONS } from '../../billing/stripe/stripe.constants';
import { Clock } from '../../common/clock/clock';
import { AppConfigModule } from '../../common/config/config.module';
import { configurations } from '../../common/config/configuration';
import { ValidationError } from '../../common/errors/domain.exception';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthModule } from '../auth.module';
import { AuthService } from './auth.service';

const PASSWORD = 'correct horse battery staple';
const OUTAGE_LENGTH = 10;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('the auth service', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let auth: AuthService;
  let stripe: FakeStripeAdapter;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        AuthModule,
      ],
    })
      .overrideProvider(StripeService)
      .useFactory({ factory: (clock: Clock) => new FakeStripeAdapter(clock), inject: [Clock] })
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    auth = moduleRef.get(AuthService);
    stripe = moduleRef.get<FakeStripeAdapter>(StripeService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    for (const operation of Object.values(STRIPE_OPERATIONS)) {
      for (let attempt = 0; attempt < OUTAGE_LENGTH; attempt += 1) {
        stripe.failNext(operation, 'rate_limit');
      }
    }
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

  it('commits the credential beside the billing and credit rows, or none of them', async () => {
    const plan = await prisma.plan.findFirstOrThrow({
      where: { code: FREE_PLAN.code, cycle: FREE_PLAN.cycle },
    });
    const { user } = await aRegisteredUser();

    const committed = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: {
        credential: true,
        billingCustomer: true,
        wallet: { include: { transactions: true } },
        subscriptions: true,
      },
    });

    expect(committed.credential).not.toBeNull();
    expect(committed.billingCustomer).not.toBeNull();
    expect(committed.subscriptions).toHaveLength(1);
    expect(committed.subscriptions[0]).toMatchObject({ status: 'ACTIVE', planId: plan.id });
    expect(committed.wallet).toMatchObject({ subscriptionCredits: plan.monthlyCredits });
    expect(committed.wallet?.transactions).toMatchObject([
      { type: 'ALLOCATION', amount: plan.monthlyCredits },
    ]);

    const collided = anEmail();
    await prisma.user.create({ data: { email: collided } });

    await expect(auth.register(collided, PASSWORD)).rejects.toThrow(ValidationError);

    const orphan = await prisma.user.findUniqueOrThrow({ where: { email: collided } });
    expect(await prisma.authCredential.count({ where: { userId: orphan.id } })).toBe(0);
    expect(await prisma.billingCustomer.count({ where: { userId: orphan.id } })).toBe(0);
    expect(await prisma.subscription.count({ where: { userId: orphan.id } })).toBe(0);
    expect(await prisma.creditWallet.count({ where: { userId: orphan.id } })).toBe(0);
  });

  it('registers while every Stripe operation fails, leaving both identifiers null', async () => {
    const { user } = await aRegisteredUser();

    expect(
      await prisma.billingCustomer.findUniqueOrThrow({ where: { userId: user.id } }),
    ).toMatchObject({ stripeCustomerId: null });
    expect(await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject(
      { stripeSubscriptionId: null },
    );
    expect(await prisma.creditWallet.count({ where: { userId: user.id } })).toBe(1);
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
