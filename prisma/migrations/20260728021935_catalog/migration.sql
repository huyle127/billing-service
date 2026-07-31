-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_paid" BOOLEAN NOT NULL,
    "credits_per_period" INTEGER NOT NULL,
    "credit_period_interval" "BillingInterval" NOT NULL,
    "credit_period_interval_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_options" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "plan_id" UUID NOT NULL,
    "billing_interval" "BillingInterval" NOT NULL,
    "billing_interval_count" INTEGER NOT NULL DEFAULT 1,
    "unit_amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addon_packages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credit_amount" INTEGER NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stripe_price_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "addon_packages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_key_key" ON "products"("key");

-- CreateIndex
CREATE UNIQUE INDEX "plans_product_id_key_key" ON "plans"("product_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_options_stripe_price_id_key" ON "pricing_options"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_options_plan_id_billing_interval_billing_interval_c_key" ON "pricing_options"("plan_id", "billing_interval", "billing_interval_count");

-- CreateIndex
CREATE UNIQUE INDEX "addon_packages_stripe_price_id_key" ON "addon_packages"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "addon_packages_product_id_key_key" ON "addon_packages"("product_id", "key");

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_options" ADD CONSTRAINT "pricing_options_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addon_packages" ADD CONSTRAINT "addon_packages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
