import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { BillingCycle, PrismaClient } from '@prisma/client';
import { seedAdmin } from './seed-admin';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL }),
});

const plans = [
  {
    code: 'free',
    name: 'Free Monthly',
    cycle: BillingCycle.MONTHLY,
    monthlyCredits: 50,
    amountCents: 0,
    stripePriceId: 'price_1TyShMFaNFL0w4nvycCBFDng',
  },
  {
    code: 'pro',
    name: 'Pro Monthly',
    cycle: BillingCycle.MONTHLY,
    monthlyCredits: 200,
    amountCents: 2000,
    stripePriceId: 'price_1TyShOFaNFL0w4nvlpwgxLOU',
  },
  {
    code: 'pro',
    name: 'Pro Annual',
    cycle: BillingCycle.ANNUAL,
    monthlyCredits: 200,
    amountCents: 20000,
    stripePriceId: 'price_1TyShPFaNFL0w4nv6QK6wNCv',
  },
];

const addonPackages = [
  {
    code: 'credits_small',
    name: 'Credits Small',
    credits: 100,
    amountCents: 1000,
    stripePriceId: 'price_1TyShQFaNFL0w4nvNMULBWHi',
  },
  {
    code: 'credits_large',
    name: 'Credits Large',
    credits: 500,
    amountCents: 4000,
    stripePriceId: 'price_1TyShRFaNFL0w4nvoIqQ8ScX',
  },
];

async function main(): Promise<void> {
  for (const plan of plans) {
    await prisma.plan.upsert({
      where: { code_cycle: { code: plan.code, cycle: plan.cycle } },
      update: { ...plan, active: true },
      create: { ...plan, active: true },
    });
  }

  for (const pkg of addonPackages) {
    await prisma.addonPackage.upsert({
      where: { code: pkg.code },
      update: { ...pkg, active: true },
      create: { ...pkg, active: true },
    });
  }

  const planCount = await prisma.plan.count();
  const packageCount = await prisma.addonPackage.count();
  console.log(`seeded ${planCount} plans, ${packageCount} addon packages`);

  await seedAdmin(prisma);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
