# TEXT AI 계약 비교 및 통합 테스트 — #96 준비

2026-10-20. **현재 판정: CONDITIONAL — 실제 서버 인증 실패로 성공 E2E 미검증.**
HTTP Mock 성공을 실제 AI 성공으로 간주하지 않는다.

## Git와 통합 상태

- 원본 workspace는 feature/#13-text-analysis / 49574f1 그대로다.
- 별도 worktree: `.worktrees/ai-integration-e2e`, 브랜치 test/ai-integration-e2e.
- #10: 로컬·origin 추적 ref 모두 34f8db1. #13: feature/#13-text-analysis 로컬 49574f1이며 feat/#13 이름/원격 ref는 없다.
- dev 로컬 115e6b0 / origin/dev b3ce599, main 로컬·origin/main 115e6b0. 로컬에 저장된 ref 기준이며 이번 작업은 fetch하지 않았다.
- 공통 기준 317791a. #13은 이미 #12의 멱등성·오류 처리와 기존 #10 HTTP Provider를 상속한다.
- #10 최신 변경 병합에서 docs/api/analysis.md, analysis.controller.ts, analysis.dto.ts 충돌이 발생했다.
  최초 지침에 따라 중단·보고한 뒤 사용자 승인을 받고, #13 JSON/길이 정책과 #10 디코딩·HTTP 오류 처리를 함께 보존했다.
- 충돌 표시는 해소됐으나 커밋 금지로 merge 커밋은 만들지 않았다. **테스트 worktree의 MERGE_HEAD는 남아 있다.**
- #10/#13/dev/main ref 및 기존 staged 파일 2개는 그대로 유지됐다. 기존 파일 SHA-256 전부 일치.
- merge baseline은 index에, 신규 TEXT AI 변경은 unstaged/신규 파일로 구분된다.
  baseline patch: `/private/tmp/ai-e2e-smlf4y32/integration-baseline.patch`.
- 원본 미커밋 백업: `/private/tmp/ai-e2e-smlf4y32/preexisting.tar`, staged.patch, manifest.json.
- worktree 보존을 위해 로컬 .git/info/exclude에 /.worktrees/만 추가했다. 원격/커밋/공유 ignore 변경 없음.

## 근거와 실제 접속

- 사용자 첨부 v0.1 초안과 실제 [OpenAPI](https://kissable-rust-strung.ngrok-free.dev/openapi.json)를 비교했다.
- 공개 OpenAPI 스냅샷: `docs/contracts/text-risk-1.0.openapi.json`.
- OpenAPI title: A.X 문자 사기 위험 분석 API, version 1.0.0.
- GET /healthz: **200**, status=ready, modelVersion=ax_text_actions-20261016, device=cuda, ocrWorkerAvailable=true.
- GET /openapi.json: **200**. Python의 로컬 CA 문제는 시스템 curl의 정상 TLS 검증으로 확인했다. TLS 검증을 끄지 않았다.
- 실제 POST /internal/v1/text-analyses 첫 합성 안내문 요청: **401**.
  환경 토큰은 존재했고 외부 공백·Bearer 중복 prefix는 없었다. 응답 원문은 출력·저장하지 않았다.
- 자동 재시도 없이 나머지 3개 TEXT 및 OCR 호출을 중단했다.
- 사용자가 토큰 갱신 후 알리겠다고 했으며, 갱신 완료 확인 전 실제 AI를 다시 호출하지 않았다.

## 세 계약 비교

| 항목 | 기존 BE #13 | AI팀 v0.1 초안 | 배포 OpenAPI / 적용 |
|---|---|---|---|
| 앱 TEXT Content-Type | application/json | multipart/form-data 제안 | 내부 TEXT는 JSON. BE JSON 유지 |
| 입력 길이 | trim 후 5~3,000 코드 포인트 | 최대 5,000 제안 | AI minLength=1/maxLength=4,000. BE 5~3,000 그대로 유지 |
| TEXT 내부 필수값 | 포트만 존재 | schemaVersion/analysisId/elementId/text | text만 필수. IDs는 선택 UUID. schemaVersion 없음, 추가 JSON 속성 금지 |
| OCR 입력 | 전용 공개 경로 없음 | 직접 TEXT 위주 | multipart file 필수, IDs 선택, sourceType=IMAGE/SCREEN_CROP |
| 인증 | 이미지 AI Bearer 서비스 인증 | 내부 인증 미정 | TEXT/OCR HTTPBearer. 실제 요청은 401로 실패 |
| 계약 버전 | TEXT AI 미연동 | schemaVersion=text-risk-v0.1 | contractVersion=text-risk-1.0, 응답의 optional/default 필드 |
| 상태 | QUEUED/ANALYZING/COMPLETED/FAILED | SUCCEEDED/FAILED 및 추가 작업 상태 제안 | 응답 status는 optional/default COMPLETED. 성공 저장은 기존 COMPLETED, 호출·계약 실패는 기존 FAILED |
| 점수 | TEXT 점수 없음 | phishingScore=0~100 위험 점수, 확률 아님 | riskScore=0~1/null, scoreScale=0..1, scoreMeaning=UNCALIBRATED_CLASSIFIER_SCORE |
| 판정·단계 | TEXT 위험도 없음 | SAFE/CAUTION/DANGER, 제안 임계값 | decision=normal/phishing/defer. riskLevel 없음. 변환·임계값 생성 안 함 |
| 근거 | 원문 미보관, preview만 | reasons[].code/description/spans | evidence:string[]. reasons/code/spans 없음 |
| 버전 | TEXT AI 버전 없음 | rule baseline/modelVersion/policyVersion | modelName/modelVersion/policyVersion 존재. rule 가중치나 임계값으로 해석하지 않음 |
| 정보 부족 | 미구현 | coverageStatus=INSUFFICIENT | quality.needsReview와 reasonCodes 및 OCR/문맥 품질 flags. coverageStatus 없음 |
| 추출 URL/전화번호 | 없음 | candidateId/value/span 배열 | 응답 필드 없음. 빈 배열을 만들어 채우거나 URL 평판 조회를 추가하지 않음 |
| 오류·재시도 | BE 공통 오류 | TEXT_* 코드/retryable 및 AWAITING_RETRY 제안 | 성공 모델에 errorCode/retryable 없음. HTTP 장애는 기존 BE 코드로 처리, 자동 재시도 없음 |
| 보관 | 원문 미보관, preview 200자, 30일 | 세션 TTL 임시 원문·재시도 제안 | 실제 응답에 text echo/OCR 본문이 있음. BE는 메모리에서 검증 후 제외, 임시 원문 저장/큐 도입 안 함 |
| 이미지 생성·변조 | 별도 CuRe·TruFor HTTP | 별도 기능 | 제공 서버에 /internal/v1/image-analyses 없음. 기존 이미지 서버 URL을 이 서버로 변경하지 않음 |

**riskScore × 100을 phishingScore로 저장하지 않는다.** 두 값은 이름/범위뿐 아니라 산출 의미가 다르다.
normal을 SAFE로, defer를 normal/0점으로 바꾸지 않는다. quality.needsReview를 coverageStatus와 동일한 뜻으로 단정하지 않는다.

## 실제 요청 및 응답 구조

Bearer 값은 환경변수에서만 읽으며 문서·코드·로그에 넣지 않는다.

```text
POST /internal/v1/text-analyses
Content-Type: application/json
Authorization: Bearer <environment-only>
Body: { text, analysisId?, elementId? }
```

BE workflow는 실제 지원되는 analysisId와 elementId만 추가한다. userId/schemaVersion/sourceType/models/deadlineAt은 JSON으로 보내지 않는다.

```text
POST /internal/v1/text-analyses/image
Content-Type: multipart/form-data (boundary 자동 생성)
Authorization: Bearer <environment-only>
Fields: file, analysisId?, elementId?, sourceType=IMAGE|SCREEN_CROP
```

models/deadlineAt/schemaVersion은 OCR 요청에도 보내지 않는다. 파일 이름은 고정된 capture.png/jpg를 사용한다.

성공 응답의 **OpenAPI 구조**는 다음과 같다. 아직 실제 200 응답을 받은 것이 아니다.

```text
contractVersion?, requestId, analysisId, elementId, sourceType, status?,
decision, riskScore, scoreScale, scoreMeaning,
modelName, modelVersion, policyVersion,
text, quality, evidence[], limitations[], processingMs
```

quality는 needsReview/reasonCodes/ocrUsed/poorOcrConfidence/layoutUncertain/contextDisagreement다.
contractVersion/status는 OpenAPI default가 있으나 wire에서 생략되면 DTO·저장 값에도 만들어 넣지 않는다.
요청 ID·분석/요소 ID·sourceType의 상관관계, score 범위/의미, 필수 필드·품질 타입을 검증한다.

## 구현과 저장 정책

### 기본/HTTP 모드

- TEXT_AI_PROVIDER=disabled가 기본이며 #13의 QUEUED/202·키 거부 정책을 유지한다.
- TEXT_AI_PROVIDER=http일 때만 동기 TEXT AI를 실행하고 기존 202/ANALYSIS202/analysisId 및 TEXT 기본 필드를 유지한다.
- AI 모드에서만 result.textResult가 추가되고 정상 처리 후 부모 Analysis는 COMPLETED다.
- 오류는 FAILED 및 ANALYSIS503 또는 COMMON500으로 처리한다. raw upstream body/trace는 반환하지 않는다.
- TEXT 직접 요청은 기존 #13처럼 Usage를 예약/차감하지 않는다. IMAGE 예약/해제 흐름은 변경하지 않았다.
- 기본 AI_REQUEST_TIMEOUT_MS를 재사용하며 wire에 deadlineAt을 보내지 않는다. Abort/Promise.race 후 늦은 결과는 DB 경로에 진입하지 못한다.

### DTO·Projection

- HttpTextAnalysisProvider: JSON/OCR 어댑터, Bearer, redirect 차단, 512KiB 응답 상한, 재시도 없음.
- TextRiskResultDto/validateTextRiskResponse: 배포 text-risk-1.0 응답 검증과 명시적 화이트리스트.
- TextAnalysisError: #12와 같은 failureKind 및 ANALYSIS503을 재사용하되 TEXT 메시지 사용. upstreamStatus는 내부 진단용이다.
- TextAiWorkflowService: 상태 처리, native mapping, 멱등성 선점, 실패 보존.
- 새 Prisma 컬럼: Analysis.textResult nullable JSONB.
- migration: 20261020010000_text_ai_result. 기존 데이터/키/모델 결과를 삭제하거나 수정하지 않는다.
- JSON에는 실제 서버가 제공한 native score/meaning/decision/IDs/버전/quality/processingMs 메타데이터만 저장한다.
- aiGenerationScore/aiRiskLevel/reasons/modelVersion 등 기존 IMAGE 의미의 컬럼을 TEXT 결과로 채우지 않는다.

AI의 text echo/OCR 및 자유문구 evidence/limitations는 DTO 메모리까지만 다루고 DB·로그·공개 재응답 데이터에서 제외한다.
따라서 현재는 **자유문구 근거의 영구 저장/공개 매핑을 완료했다고 주장하지 않는다.**
AI팀과 마스킹·공개 범위를 합의해야 한다. 이 선택은 원문 유출을 피하고 완료 키의 정확한 응답 재사용을 유지하기 위한 보수적인 임시 제한이다.
원래 #13의 직접 입력 preview(최대 200자)와 30일 만료는 그대로다. 짧은 입력은 preview가 전체 내용과 같을 수 있다.

### 멱등성

기존 claim의 사용자+키 unique insert를 재사용하며 TEXT용 type/preview/생성시각만 선택적으로 받게 확장했다.
같은 내용 완료 키는 같은 응답, 처리 중/내용 충돌/만료는 409, 실패는 저장된 BE 오류를 재사용한다.
서로 다른 키나 키 없는 요청은 새 분석이다. IMAGE/TEXT 간 같은 키 충돌도 기존 요청을 덮어쓰지 않는다.
원문을 저장하지 않으므로 실패 후 새 실행은 새 키와 원문 재입력이 필요하다.

### OCR 공개 경로

기존 POST IMAGE를 OCR로 바꾸지 않았다. 현재 TEXT 캡처 전용 공개 경로는 없다.
HttpTextAnalysisProvider.analyzeImage와 명시적 live 테스트의 OCR→repository 경로만 준비했다.
후속 설계 후보는 별도 POST /api/analysis/text-image이지만 **경로를 추가하지 않았다.**
공개 노출 전 업로드 계약·인증·디코딩 검증·미리보기 정책을 합의해야 한다.

## 검증 결과 구분

| 범위 | 결과 | 근거 |
|---|---|---|
| Health/OpenAPI 실제 접속 | PASS | 두 GET 200 |
| Unit/DTO/Projection | PASS | 점수·의미·context·null/defer·누락·원문 제외 |
| TEXT/OCR HTTP Mock | PASS | JSON/form 필드·Bearer·401/403/4xx/5xx/network/JSON 오류 |
| Prisma Mock | PASS | 기존 #13 및 IMAGE 저장 계약 회귀 |
| backend→HTTP Mock→실제 PostgreSQL | PASS | 새 TEXT workflow 15개 테스트 |
| 실제 AI TEXT 직접 호출 | FAIL | 첫 요청 401. 나머지 3개 중단 |
| 실제 AI OCR 직접 호출 | NOT TESTED | 인증 실패 후 중단 |
| backend→실제 AI | NOT TESTED | 유효 토큰 갱신 확인 대기 |
| backend→실제 AI→PostgreSQL | NOT TESTED | 실제 성공 응답 없음 |
| OCR 실제 AI→repository→DB | NOT TESTED | opt-in harness 준비, 미실행 |
| 기존 CuRe·TruFor Mock/DB 회귀 | PASS | 양방향 부분 실패·전체 실패·DB 결과 검증 |
| 실제 CuRe·TruFor | NOT TESTED | 제공 서버에 이미지 생성·변조 endpoint 없음 |
| 실제 DB migration / schema diff | PASS | 새 격리 DB에 7개 migration 적용, No difference detected |
| TEXT 동시 중복 요청 | PASS | 8요청 → 202 1개/409 7개, 분석 1행·AI Mock 호출 1회 |
| 기존 IMAGE 단일/다중 프로세스 동시 요청 | PASS | 각각 12요청 → 분석 1행/모델 결과 2행/AI 1회/Usage 예약 1회 |

전체 결과: **300 passed / 1 skipped (live opt-in suite)**, 12 suites passed.
일부 재사용 #13 진단 테스트는 이미 알려진 NUL/surrogate 500 및 Swagger oneOf 혼재를 재현하며,
테스트가 통과했다는 이유로 그 문제가 수정됐다고 판단하지 않는다. #13 입력 정책/기능은 이번 작업에서 바꾸지 않았다.
Prisma validate/generate, TypeScript, build, staged/unstaged diff --check 통과.

PostgreSQL은 새 localhost/pb23_test_1792490961279/public만 사용했다.
실제 AI 결과 행을 저장한 것이 아니라 HTTP Mock fixture 결과를 저장한 검증이다.
기존 개발·운영 DB, 이전 검증 DB에 migration을 적용하지 않았다. reset/DROP DATABASE/데이터 삭제 없음.

## 실행 방법

테스트 worktree에서 실행한다. 현재 임시 도구는 접속 값을 출력하지 않고 비공개 상태 파일에서 읽는다.

```bash
# 실제 AI를 강제로 비활성화하고 Mock + 격리 DB 회귀
node /private/tmp/ai-e2e-smlf4y32/db-tests.cjs

# 해당 서버용 토큰 갱신 확인 후에만 명시적으로 실행
node /private/tmp/ai-e2e-smlf4y32/run-live.cjs
```

live suite는 기본 skip이다. AI_E2E_LIVE=1, AI_SERVICE_BASE_URL, 환경 토큰,
명시적 AI_E2E_DB_URL이 모두 필요하고 서버 host와 테스트 DB 이름 guard를 검사한다.
4개 합성 문자열 직접 호출 → 4개 backend/DB 요청 및 완료 재전송 → 1개 합성 OCR/DB를 순서대로 실행하고 첫 실패 시 나머지를 중단한다.
AI의 예상 정답을 강제하지 않고 실제 native decision/score/quality만 기록한다.
OCR 이미지는 메모리에서 만들고 해제한다. 결과 파일은 text/evidence/limitations를 제외한 metadata만 0600으로 저장한다.
아직 이 live suite는 실행하지 않았다. 최초 별도 direct 호출의 401 결과와 혼동하지 않는다.

.env.example에는 기본 disabled와 TEXT 전용 base/token 선택을 설명했다.
AI_SERVER_BASE_URL은 기존 IMAGE 전용이고 AI_SERVICE_BASE_URL은 새 TEXT 전용이다.
서버별 토큰이 다르면 TEXT_AI_SERVICE_TOKEN을 분리해 쓸 수 있고, 미설정 시 기존 AI_SERVICE_TOKEN을 사용한다.
원본 .env는 수정하지 않았다.

## #96 분리 대상

신규 운영 코드:

- src/domains/analysis/http-text-analysis.provider.ts
- src/domains/analysis/text-risk.dto.ts
- src/domains/analysis/text-analysis.error.ts
- src/domains/analysis/text-ai-workflow.service.ts

기존 코드의 #96 hunk:

- analysis.module.ts: TEXT Provider/workflow 등록
- analysis.service.ts: 기본 QUEUED 유지, opt-in HTTP 분기
- analysis.controller.ts: opt-in TEXT 키 전달·설명·textResult 문서화
- analysis.repository.ts: claim의 TEXT 메타데이터 확장, completeText 상태 guard
- text-analysis.input.ts: 선택적 elementId
- prisma/schema.prisma 및 새 nullable textResult migration
- .env.example: 명시적 TEXT 설정

검증 자료:

- test/text-ai-http.e2e-spec.ts, text-ai-postgres.e2e-spec.ts, text-ai-live.e2e-spec.ts
- test/fixtures/text-risk.ts
- test/analysis.e2e-spec.ts의 새 scalar fixture 필드
- docs/contracts/text-risk-1.0.openapi.json 및 본 보고서
- text-analysis-postgres.e2e-spec.ts는 기존 #13 검증 테스트를 원본 변경 없이 복사한 것이며 #96 운영 코드가 아니다.

새 커밋은 없고 기존 #10/#13 기능 커밋과 uncommitted merge baseline 및 새 #96 hunk가 구분돼 있다.
전체 테스트 브랜치를 dev에 병합하지 않았으며 향후 baseline 정리 후 위 #96 hunk만 별도로 분리해야 한다.

## AI팀/BE 추가 합의와 남은 문제

1. 제공 TEXT 서버에 유효한 Bearer 토큰 및 서버별 토큰 분리 확인. 현재 401이므로 실제 성공 판정 불가.
2. uncalibrated riskScore를 제품의 phishingScore/riskLevel로 표현할지, 표현한다면 별도 검증·정책·버전 확정.
3. evidence/limitations의 민감정보 제거 보장과 공개/영구 보관 범위. 현재 자유문구는 저장/재응답하지 않는다.
4. reasons 코드/위치, extractedUrls/extractedPhones, coverageStatus, retryable 등 초안 필드의 실제 도입 여부.
5. OCR 공개 API와 raw OCR 미보관·preview 정책. 기존 IMAGE API를 재해석하지 않음.
6. BE 3,000자/AI 4,000자/초안 5,000자 차이. 이번에는 #13 제한 유지.
7. 원문 미보관으로 비동기 재처리 불가. 임시 저장/큐/자동 재시도는 도입하지 않음.
8. AI 10초 초안과 실제 실행 시간/현재 BE 예산 차이, 운영 성능·과금 정책. 이번 검증 타임아웃은 운영 정책 확정이 아님.
9. 기존 #13의 DB 비호환 문자 처리·Swagger media schema 혼재는 별도 후속 사항.
10. 토큰 갱신 후 live matrix가 실제 서버 응답을 수용하는지 최종 검증해야 #96을 PASS로 판정할 수 있음.
