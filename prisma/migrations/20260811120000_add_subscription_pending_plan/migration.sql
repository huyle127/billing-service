-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "pendingCycle" "BillingCycle",
ADD COLUMN     "pendingPlanId" TEXT;

