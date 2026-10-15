-- CreateEnum
CREATE TYPE "ImageResultStatus" AS ENUM ('COMPLETED', 'PARTIAL_FAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageModelKind" AS ENUM ('GENERATION', 'MANIPULATION');

-- CreateEnum
CREATE TYPE "ImageModelStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageModelDecision" AS ENUM ('AI_GENERATED_SUSPECTED', 'NO_CLEAR_GENERATION_SIGNAL', 'MANIPULATION_SUSPECTED', 'NO_CLEAR_MANIPULATION_SIGNAL', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "AnalysisSummaryStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "analysis_requests" ADD COLUMN     "imageResultStatus" "ImageResultStatus",
ADD COLUMN     "summarizedAt" TIMESTAMP(3),
ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryModel" TEXT,
ADD COLUMN     "summaryStatus" "AnalysisSummaryStatus";

-- CreateTable
CREATE TABLE "analysis_model_results" (
    "id" UUID NOT NULL,
    "analysisId" UUID NOT NULL,
    "kind" "ImageModelKind" NOT NULL,
    "status" "ImageModelStatus" NOT NULL,
    "displayScore" INTEGER,
    "decision" "ImageModelDecision" NOT NULL,
    "reasons" JSONB NOT NULL,
    "limitations" TEXT[],
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "errorCode" TEXT,
    "retryable" BOOLEAN,

    CONSTRAINT "analysis_model_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analysis_model_results_analysisId_kind_key" ON "analysis_model_results"("analysisId", "kind");

-- AddForeignKey
ALTER TABLE "analysis_model_results" ADD CONSTRAINT "analysis_model_results_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analysis_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BE projection invariant: 표시 점수만 저장하며 모델 실패는 오류 코드를 가진다.
ALTER TABLE "analysis_model_results" ADD CONSTRAINT "analysis_model_results_display_score_check"
CHECK ("displayScore" IS NULL OR "displayScore" BETWEEN 0 AND 100);
ALTER TABLE "analysis_model_results" ADD CONSTRAINT "analysis_model_results_error_check"
CHECK (("status" = 'SUCCEEDED' AND "errorCode" IS NULL) OR
       ("status" = 'FAILED' AND "errorCode" IS NOT NULL AND length("errorCode") > 0));
