-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider_payment_method_id" TEXT NOT NULL,
    "brand" TEXT,
    "last4" TEXT,
    "exp_month" INTEGER,
    "exp_year" INTEGER,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_provider_payment_method_id_key"
  ON "payment_methods" ("provider_payment_method_id");

-- CreateIndex
CREATE INDEX "payment_methods_user_id_idx" ON "payment_methods" ("user_id");

-- AddForeignKey
ALTER TABLE "payment_methods"
  ADD CONSTRAINT "payment_methods_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express (design D6).
-- ---------------------------------------------------------------------------

-- At most one default payment method per user.
--
-- A partial unique index rather than an application check: "one default" has to
-- be true against a stray updateMany, a concurrent set-default, and a manual
-- psql session, not only against the service that usually writes here. Partial
-- over `is_default = true`, because the constraint says nothing about how many
-- *non*-default methods a user may hold (design D2).
--
-- Keyed on `user_id` alone: inside the predicate `is_default` is constant, so
-- including it would add a column that cannot vary. This is the same index as
-- the plan's `(user_id, is_default) WHERE is_default = true`.
CREATE UNIQUE INDEX "payment_methods_one_default_per_user"
  ON "payment_methods" ("user_id")
  WHERE "is_default";
