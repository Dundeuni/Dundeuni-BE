ALTER TYPE "AnalysisType" ADD VALUE 'PHONE';
CREATE TABLE "phone_analysis_results" (
 "analysisId" UUID PRIMARY KEY REFERENCES "analysis_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "phoneNumber" TEXT NOT NULL,
 "provider" TEXT NOT NULL DEFAULT 'APICK',
 "riskLevel" TEXT, "spamType" TEXT, "reportCount" INTEGER,
 "reportCountRaw" TEXT, "cyberCrime" TEXT, "reasons" JSONB,
 "rawData" JSONB, "normalizedData" JSONB, "policyVersion" TEXT,
 "analyzedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
