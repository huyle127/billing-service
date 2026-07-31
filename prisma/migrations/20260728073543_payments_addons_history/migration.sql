-- DropIndex
DROP INDEX "payments_provider_invoice_id_key";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "attempt_number" INTEGER;

-- ---------------------------------------------------------------------------
-- Invariants Prisma cannot express (design D6).
-- ---------------------------------------------------------------------------

-- Payment ↔ Stripe object is 1-to-1, per *attempt*.
--
-- The plain unique index on the invoice identifier this replaces could not hold:
-- a dunning cycle produces up to three payment attempts against one invoice, and
-- each is its own record. The Stripe identifier for a recurring attempt is
-- therefore the pair (invoice, attempt), not the invoice alone.
--
-- NULLS NOT DISTINCT so that an attempt reported without an attempt number still
-- deduplicates against a redelivery of the same one, rather than every such row
-- being unique by virtue of holding a null.
CREATE UNIQUE INDEX "payments_one_row_per_invoice_attempt"
  ON "payments" ("provider_invoice_id", "attempt_number") NULLS NOT DISTINCT
  WHERE "provider_invoice_id" IS NOT NULL;
