-- The ledger's write order, and the only total order it has.
--
-- `created_at` defaults to the transaction timestamp, so every row of one
-- movement — an expiry and the allocation that follows it, or the three rows of
-- a consumption spanning three grants — carries an identical value, leaving a
-- uuid primary key as the tiebreak. Replaying a running balance in uuid order
-- produces a different answer every time it is read, so the ledger needs a
-- sequence of its own.
ALTER TABLE "credit_transactions"
  ADD COLUMN "sequence" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "credit_transactions_sequence_key"
  ON "credit_transactions" ("sequence");
