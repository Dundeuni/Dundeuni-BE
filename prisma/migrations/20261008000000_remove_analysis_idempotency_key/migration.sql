-- 기존 분석 기록은 유지하고 사용하지 않는 멱등성 키만 제거한다.
DROP INDEX "public"."analysis_requests_userId_idempotencyKey_key";
ALTER TABLE "public"."analysis_requests" DROP COLUMN "idempotencyKey";
