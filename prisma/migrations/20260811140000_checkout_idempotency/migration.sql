-- One row per checkout submission, so a double-click, a retry or a second tab
-- produce one set of orders. Additive, so no downtime.

-- CreateTable
CREATE TABLE "public"."CheckoutRequest" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderIds" TEXT[],
    "paymentMethod" "public"."PaymentMethod" NOT NULL,
    "sessionUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutRequest_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "CheckoutRequest_userId_idx" ON "public"."CheckoutRequest"("userId");
