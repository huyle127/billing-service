import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { Plan, Subscription, SubscriptionStatus, User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../../common/clock/clock';
import { AppConfigModule } from '../../common/config/config.module';
import { AppConfigService } from '../../common/config/app-config.service';
import { configurations } from '../../common/config/configuration';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BillingModule } from '../billing.module';
import { FREE_PLAN } from '../billing.constants';
import { FakeStripeAdapter } from '../stripe/adapters/fake-stripe.adapter';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { STRIPE_OPERATIONS } from '../stripe/stripe.constants';
import { StripeAdapterError } from '../stripe/stripe.error';
import { EntitlementService } from './entitlement.service';
import { ProvisioningService } from './provisioning.service';

const BATCH_SIZE = 2;
const AN_HOUR = 3_600_000;

describe('provisioning the Stripe objects a registration deferred', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let entitlement: EntitlementService;
  let provisioning: ProvisioningService;
  let stripe: FakeStripeAdapter;
  let clock: Clock;
  let plan: Plan;
  let originalBatchSize: string | undefined;

  beforeAll(async () => {
    originalBatchSize = process.env.PROVISIONING_BATCH_SIZE;
    process.env.PROVISIONING_BATCH_SIZE = String(BATCH_SIZE);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: configurations, cache: true }),
        AppConfigModule,
        PrismaModule,
        BillingModule,
      ],
    })
      .overrideProvider(StripeService)
      .useFactory({ factory: (at: Clock) => new FakeStripeAdapter(at), inject: [Clock] })
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    entitlement = moduleRef.get(EntitlementService);
    provisioning = moduleRef.get(ProvisioningService);
    stripe = moduleRef.get<FakeStripeAdapter>(StripeService);
    clock = moduleRef.get(Clock);
    plan = await prisma.plan.findFirstOrThrow({
      where: { code: FREE_PLAN.code, cycle: FREE_PLAN.cycle },
    });

    expect(moduleRef.get(AppConfigService).provisioningBatchSize).toBe(BATCH_SIZE);
  });

  afterAll(async () => {
    await moduleRef.close();
    process.env.PROVISIONING_BATCH_SIZE = originalBatchSize;
  });

  async function aPendingUser(): Promise<{ user: User; subscription: Subscription }> {
    const user = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.test` },
    });

    await prisma.$transaction((tx) => entitlement.grantOnRegistration(tx, user));

    return {
      user,
      subscription: await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } }),
    };
  }

  function customerOf(userId: string) {
    return prisma.billingCustomer.findUniqueOrThrow({ where: { userId } });
  }

  function subscriptionOf(id: string) {
    return prisma.subscription.findUniqueOrThrow({ where: { id } });
  }

  it('attaches both identifiers and leaves no sync state behind', async () => {
    const { user, subscription } = await aPendingUser();

    await provisioning.provision(user.id);

    const customer = await customerOf(user.id);
    expect(customer.stripeCustomerId).toMatch(/^cus_fake_/);
    expect(customer).toMatchObject({ syncAttempts: 0, syncError: null });

    const attached = await subscriptionOf(subscription.id);
    expect(attached.stripeSubscriptionId).toMatch(/^sub_fake_/);
    expect(attached).toMatchObject({
      stripePriceId: plan.stripePriceId,
      stripeStatus: 'active',
      syncAttempts: 0,
      syncError: null,
    });
  });

  it('creates nothing a second time when it runs again', async () => {
    const { user, subscription } = await aPendingUser();
    const customers = stripe.customerCount;
    const subscriptions = stripe.subscriptionCount;

    await provisioning.provision(user.id);
    const first = await customerOf(user.id);
    const firstSubscription = await subscriptionOf(subscription.id);

    await provisioning.provision(user.id);

    expect(await customerOf(user.id)).toMatchObject({
      stripeCustomerId: first.stripeCustomerId,
    });
    expect(await subscriptionOf(subscription.id)).toMatchObject({
      stripeSubscriptionId: firstSubscription.stripeSubscriptionId,
    });
    expect(stripe.customerCount).toBe(customers + 1);
    expect(stripe.subscriptionCount).toBe(subscriptions + 1);
  });

  it('adopts an object Stripe already holds once the idempotency key has expired', async () => {
    const { user, subscription } = await aPendingUser();

    const orphanedCustomer = await stripe.createCustomer({ userId: user.id, email: user.email });
    const orphanedSubscription = await stripe.createSubscription({
      subscriptionId: subscription.id,
      userId: user.id,
      customerId: orphanedCustomer.id,
      priceId: plan.stripePriceId,
    });
    stripe.expireIdempotencyKeys();

    const customers = stripe.customerCount;
    const subscriptions = stripe.subscriptionCount;

    await provisioning.provision(user.id);

    expect(stripe.customerCount).toBe(customers);
    expect(stripe.subscriptionCount).toBe(subscriptions);
    expect(await customerOf(user.id)).toMatchObject({ stripeCustomerId: orphanedCustomer.id });
    expect(await subscriptionOf(subscription.id)).toMatchObject({
      stripeSubscriptionId: orphanedSubscription.id,
    });
  });

  it('records a failure on the row, backs off further each time, and clears it on success', async () => {
    const { user } = await aPendingUser();

    stripe.failNext(STRIPE_OPERATIONS.findCustomerByUserId, 'rate_limit');
    await expect(provisioning.provision(user.id)).rejects.toBeInstanceOf(StripeAdapterError);

    const first = await customerOf(user.id);
    expect(first).toMatchObject({ stripeCustomerId: null, syncAttempts: 1 });
    expect(first.syncError).toContain(STRIPE_OPERATIONS.findCustomerByUserId);

    stripe.failNext(STRIPE_OPERATIONS.findCustomerByUserId, 'rate_limit');
    await expect(provisioning.provision(user.id)).rejects.toBeInstanceOf(StripeAdapterError);

    const second = await customerOf(user.id);
    expect(second).toMatchObject({ stripeCustomerId: null, syncAttempts: 2 });
    expect(second.syncNextAttemptAt.getTime()).toBeGreaterThan(first.syncNextAttemptAt.getTime());

    await provisioning.provision(user.id);

    expect(await customerOf(user.id)).toMatchObject({ syncAttempts: 0, syncError: null });
  });

  it('persists one customer and one Stripe object when two runs race the same user', async () => {
    const { user } = await aPendingUser();
    const customers = stripe.customerCount;
    const subscriptions = stripe.subscriptionCount;

    await Promise.all([provisioning.provision(user.id), provisioning.provision(user.id)]);

    expect(stripe.customerCount).toBe(customers + 1);
    expect(stripe.subscriptionCount).toBe(subscriptions + 1);
    expect((await customerOf(user.id)).stripeCustomerId).toMatch(/^cus_fake_/);
    expect(
      await prisma.subscription.count({
        where: { userId: user.id, stripeSubscriptionId: { not: null } },
      }),
    ).toBe(1);
  });

  it('sweeps everything outstanding and leaves a row not yet due alone', async () => {
    const due = await aPendingUser();
    const alsoDue = await aPendingUser();
    const later = await aPendingUser();

    await prisma.subscription.update({
      where: { id: later.subscription.id },
      data: { syncNextAttemptAt: new Date(clock.now().getTime() + AN_HOUR) },
    });

    await provisioning.sweep();

    expect((await subscriptionOf(due.subscription.id)).stripeSubscriptionId).not.toBeNull();
    expect((await subscriptionOf(alsoDue.subscription.id)).stripeSubscriptionId).not.toBeNull();

    const untouched = await subscriptionOf(later.subscription.id);
    expect(untouched).toMatchObject({ stripeSubscriptionId: null, syncAttempts: 0 });
  });

  it('never picks up an expired subscription, because history is not a backlog', async () => {
    const { subscription } = await aPendingUser();

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    await provisioning.sweep();

    expect(await subscriptionOf(subscription.id)).toMatchObject({
      stripeSubscriptionId: null,
      syncAttempts: 0,
      syncNextAttemptAt: subscription.syncNextAttemptAt,
    });
  });

  it('provisions at most one batch and leaves the remainder pending', async () => {
    for (let user = 0; user < BATCH_SIZE + 1; user += 1) {
      await aPendingUser();
    }

    await provisioning.sweep();

    expect(
      await prisma.subscription.count({ where: { stripeSubscriptionId: { not: null } } }),
    ).toBe(BATCH_SIZE);
    expect(await prisma.subscription.count({ where: { stripeSubscriptionId: null } })).toBe(1);
  });

  it('provisions each row once when two sweeps run at the same time', async () => {
    await aPendingUser();
    await aPendingUser();
    const subscriptions = stripe.subscriptionCount;

    await Promise.all([provisioning.sweep(), provisioning.sweep()]);

    expect(stripe.subscriptionCount).toBe(subscriptions + BATCH_SIZE);
    expect(await prisma.subscription.count({ where: { stripeSubscriptionId: null } })).toBe(0);
  });
});
