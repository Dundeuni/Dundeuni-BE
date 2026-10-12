-- 이미 적용된 migration을 유지하고 실패 모델의 판정을 nullable로 확장한다.
ALTER TABLE "analysis_model_results" ALTER COLUMN "decision" DROP NOT NULL;
-- 기존 비정상 데이터가 있으면 적용을 중단한다. 자동 삭제/변환하지 않는다.
ALTER TABLE "analysis_model_results" ADD CONSTRAINT "analysis_model_results_status_payload_check"
CHECK (("status" = 'FAILED' AND "decision" IS NULL AND "displayScore" IS NULL)
    OR ("status" = 'SUCCEEDED' AND "decision" IS NOT NULL));
