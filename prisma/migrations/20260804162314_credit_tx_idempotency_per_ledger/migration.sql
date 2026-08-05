-- DropIndex
DROP INDEX "credit_transactions_idempotencyKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "credit_transactions_idempotencyKey_ledger_key" ON "credit_transactions"("idempotencyKey", "ledger");
