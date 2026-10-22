-- Native text-risk-1.0 metadata, never raw input/OCR/free-form evidence. Existing rows remain NULL.
ALTER TABLE "analysis_requests" ADD COLUMN "textResult" JSONB;
