-- Preserve existing records. Historical updatedAt starts at their creation time.
ALTER TABLE "analysis_requests"
  ADD COLUMN "updatedAt" TIMESTAMP(3),
  ADD COLUMN "textPreview" VARCHAR(200);
UPDATE "analysis_requests" SET "updatedAt" = "createdAt";
ALTER TABLE "analysis_requests"
  ALTER COLUMN "updatedAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
-- Original text is intentionally not stored.
