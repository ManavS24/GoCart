-- Index every foreign key not already covered: Postgres does not index one
-- automatically. The three absent ones each already lead an existing index.
--
-- Not CONCURRENTLY, which cannot run inside Prisma's migration transaction.

-- CreateIndex
CREATE INDEX "Product_storeId_idx" ON "public"."Product"("storeId");

-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "public"."Order"("userId");

-- CreateIndex
CREATE INDEX "Order_storeId_idx" ON "public"."Order"("storeId");

-- CreateIndex
CREATE INDEX "Order_addressId_idx" ON "public"."Order"("addressId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "public"."OrderItem"("productId");

-- CreateIndex
CREATE INDEX "Rating_productId_idx" ON "public"."Rating"("productId");

-- CreateIndex
CREATE INDEX "Address_userId_idx" ON "public"."Address"("userId");
