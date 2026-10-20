-- Nullable keys preserve all existing records and allow independent requests without a key.
ALTER TABLE "analysis_requests" ADD COLUMN "idempotencyKey" VARCHAR(128);
CREATE UNIQUE INDEX "analysis_requests_userId_idempotencyKey_key"
ON "analysis_requests"("userId", "idempotencyKey");
