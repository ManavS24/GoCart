-- `OrderStatusChange` gives transitions a durable home: the Order row holds
-- only the latest value. The composites replace single-column indexes on the
-- same leading column, serving the sort as well as the filter.
--
-- expand-contract: the DROP INDEX statements are the contract half, safe with
-- the previous release running -- the replacements are created first.

-- CreateTable
CREATE TABLE "public"."OrderStatusChange" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "from" "public"."OrderStatus" NOT NULL,
    "to" "public"."OrderStatus" NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderStatusChange_orderId_idx" ON "public"."OrderStatusChange"("orderId");

-- AddForeignKey
ALTER TABLE "public"."OrderStatusChange" ADD CONSTRAINT "OrderStatusChange_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "public"."Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "public"."Order"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_storeId_createdAt_idx" ON "public"."Order"("storeId", "createdAt");

-- DropIndex
DROP INDEX "public"."Order_userId_idx";

-- DropIndex
DROP INDEX "public"."Order_storeId_idx";
