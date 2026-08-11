-- `Order.couponCode` makes redemption a query against orders that stand,
-- needing no second ledger to release. NULL `maxRedemptions` is unlimited.
--
-- Additive: existing orders keep NULL, so earlier uses miss their cap.

-- AlterTable
ALTER TABLE "public"."Order" ADD COLUMN     "couponCode" TEXT;

-- AlterTable
ALTER TABLE "public"."Coupon" ADD COLUMN     "maxRedemptions" INTEGER;

-- CreateIndex
CREATE INDEX "Order_couponCode_idx" ON "public"."Order"("couponCode");
