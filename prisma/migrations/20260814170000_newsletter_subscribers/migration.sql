-- Stores newsletter sign-ups, which the form previously discarded. Additive:
-- a new table the previous release neither reads nor writes.

-- CreateTable
CREATE TABLE "public"."NewsletterSubscriber" (
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsletterSubscriber_pkey" PRIMARY KEY ("email")
);
