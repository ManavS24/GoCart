-- Adds RAZORPAY alongside COD and STRIPE. Additive: no existing row changes and
-- the previous release, which never writes the new value, keeps working.

-- AlterEnum
ALTER TYPE "public"."PaymentMethod" ADD VALUE 'RAZORPAY';
