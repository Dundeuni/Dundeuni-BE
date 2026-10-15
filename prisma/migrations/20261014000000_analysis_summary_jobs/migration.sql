CREATE TYPE "SummaryJobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TABLE "analysis_summary_jobs" (
  "analysisId" UUID NOT NULL,
  "status" "SummaryJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "leaseToken" UUID,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analysis_summary_jobs_pkey" PRIMARY KEY ("analysisId"),
  CONSTRAINT "analysis_summary_jobs_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analysis_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "analysis_summary_jobs_status_nextRunAt_idx" ON "analysis_summary_jobs"("status", "nextRunAt");
