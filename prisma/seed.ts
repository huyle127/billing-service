import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  CATALOG,
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../src/catalog/catalog-seed';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Seeds the catalog from the definition in `src/catalog/catalog-seed.ts`,
 * taking Stripe Price identifiers from the environment. See
 * `docs/stripe-setup.md` for the Stripe objects these must correspond to.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');
  }

  const priceIds = Object.fromEntries(
    CATALOG_PRICE_REFS.map((ref) => [ref, process.env[ref] ?? '']),
  );

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    await seedCatalog(prisma, priceIds);
    console.log(
      `Seeded product "${CATALOG.product.key}": ${CATALOG.plans.length} plans, ` +
        `${CATALOG.pricingOptions.length} pricing options, ` +
        `${CATALOG.addonPackages.length} add-on SKUs.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
