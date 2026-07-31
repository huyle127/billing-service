-- CreateEnum
CREATE TYPE "CreditGrantSource" AS ENUM ('SUBSCRIPTION', 'ADDON', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('ALLOCATION', 'CONSUMPTION', 'EXPIRY', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "credit_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "source" "CreditGrantSource" NOT NULL,
    "amount_initial" INTEGER NOT NULL,
    "amount_remaining" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3),
    "credit_period_start" TIMESTAMP(3),
    "credit_period_end" TIMESTAMP(3),
    "subscription_id" UUID,
    "addon_purchase_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "credit_grant_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "idempotency_key" TEXT,
    "type" "CreditTransactionType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "grant_amount_remaining_after" INTEGER NOT NULL,
    "related_event_type" TEXT,
    "related_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "credit_grants_user_id_product_id_amount_remaining_idx" ON "credit_grants"("user_id", "product_id", "amount_remaining");

-- CreateIndex
CREATE INDEX "credit_grants_subscription_id_idx" ON "credit_grants"("subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_transactions_idempotency_key_key" ON "credit_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "credit_transactions_credit_grant_id_idx" ON "credit_transactions"("credit_grant_id");

-- CreateIndex
CREATE INDEX "credit_transactions_operation_id_idx" ON "credit_transactions"("operation_id");

-- AddForeignKey
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_credit_grant_id_fkey" FOREIGN KEY ("credit_grant_id") REFERENCES "credit_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express (design D6). Hand-written, and asserted by
-- tests that attempt the violating write directly — so removing one of these
-- fails a test rather than silently weakening the system.
-- ---------------------------------------------------------------------------

-- Credit never goes negative. This is the backstop behind the application's
-- own sufficiency check: no code path, migration, or manual session can
-- overdraw a grant.
ALTER TABLE "credit_grants"
  ADD CONSTRAINT "credit_grants_amount_remaining_non_negative"
  CHECK ("amount_remaining" >= 0);

-- A grant never claims to have started with less than it has left.
ALTER TABLE "credit_grants"
  ADD CONSTRAINT "credit_grants_amount_remaining_within_initial"
  CHECK ("amount_remaining" <= "amount_initial");

-- One subscription-sourced grant per credit period. Two independent paths can
-- allocate for the same period — the paid invoice and the scheduled reset —
-- and they have different idempotency keys, so webhook idempotency does not
-- help here. This partial index is the only thing standing between an annual
-- subscriber and a double allocation in month one, and it must exist before
-- the reset job is written.
CREATE UNIQUE INDEX "credit_grants_subscription_credit_period_unique"
  ON "credit_grants" ("subscription_id", "credit_period_start")
  WHERE "source" = 'SUBSCRIPTION';
