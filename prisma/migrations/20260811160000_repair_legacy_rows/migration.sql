-- Repairs rows written under the old rules. All idempotent, so re-running is
-- harmless.

-- Rejection recorded the decision without clearing `isActive`, so a rejected
-- store's products stayed on the storefront.
UPDATE "public"."Store"
   SET "isActive" = false
 WHERE "status" = 'rejected'
   AND "isActive" = true;

-- A discount above 100 produced a negative order total. Clamped rather than
-- deleted: 100 is what the checkout would already have applied.
UPDATE "public"."Coupon"
   SET "discount" = 100
 WHERE "discount" > 100;

UPDATE "public"."Coupon"
   SET "discount" = 1
 WHERE "discount" <= 0;

-- Backfilled from the JSON snapshot, where the code was recorded all along.
UPDATE "public"."Order"
   SET "couponCode" = "coupon"->>'code'
 WHERE "couponCode" IS NULL
   AND "isCouponUsed" = true
   AND "coupon" ? 'code';
