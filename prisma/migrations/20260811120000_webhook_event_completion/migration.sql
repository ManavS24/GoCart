-- Two-phase webhook ledger: a claimed event id only suppresses redelivery once
-- its mutations have committed. Additive and nullable, so no downtime.
--
-- Existing rows stay NULL: the previous handler claimed before mutating, so an
-- old row is no evidence the work completed.

-- AlterTable
ALTER TABLE "public"."ProcessedWebhookEvent" ADD COLUMN     "completedAt" TIMESTAMP(3);
