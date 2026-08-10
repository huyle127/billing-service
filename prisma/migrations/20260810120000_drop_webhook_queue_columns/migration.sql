-- AlterEnum
BEGIN;
CREATE TYPE "WebhookStatus_new" AS ENUM ('RECEIVED', 'COMPLETED', 'FAILED');
ALTER TABLE "public"."WebhookEvent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "WebhookEvent" ALTER COLUMN "status" TYPE "WebhookStatus_new" USING ("status"::text::"WebhookStatus_new");
ALTER TYPE "WebhookStatus" RENAME TO "WebhookStatus_old";
ALTER TYPE "WebhookStatus_new" RENAME TO "WebhookStatus";
DROP TYPE "public"."WebhookStatus_old";
ALTER TABLE "WebhookEvent" ALTER COLUMN "status" SET DEFAULT 'RECEIVED';
COMMIT;

-- DropIndex
DROP INDEX "WebhookEvent_status_nextAttemptAt_idx";

-- AlterTable
ALTER TABLE "WebhookEvent" DROP COLUMN "nextAttemptAt",
DROP COLUMN "retryCount";

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");
