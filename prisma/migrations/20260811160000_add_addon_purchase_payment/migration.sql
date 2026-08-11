-- AlterTable
ALTER TABLE "PaymentTransaction" ADD COLUMN     "addonPackageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentTransaction_stripePaymentIntentId_key" ON "PaymentTransaction"("stripePaymentIntentId");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_addonPackageId_fkey" FOREIGN KEY ("addonPackageId") REFERENCES "AddonPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
