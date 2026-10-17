-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AnalysisType" AS ENUM ('IMAGE', 'TEXT', 'URL');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "analysis_requests" (
    "id" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AnalysisType" NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "aiGenerationScore" DOUBLE PRECISION,
    "aiRiskLevel" TEXT,
    "reasons" JSONB,
    "modelVersion" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analysis_requests_userId_idempotencyKey_key" ON "analysis_requests"("userId", "idempotencyKey");
