# Analysis API

분석 유형은 `IMAGE`, `TEXT`, `URL`을 P0으로 우선 지원합니다. `VIDEO`, `PHONE`, `QR`은 P1 이후 별도 이슈로 확장합니다.

AI 생성·변조 가능성과 사기 위험은 하나의 점수로 합치지 않고 별도 결과와 판단 근거를 반환합니다.

## POST /api/analysis — IMAGE

로그인 미구현으로 AccessTokenGuard를 임시 주석 처리했다. Authorization 헤더 없이 요청할 수 있다.
모든 요청은 임시 사용자 `development-user`로 저장한다. 로그인 구현 후 Guard와 인증 사용자 ID를 복원한다.

요청은 `multipart/form-data`이며 필드는 `type=IMAGE`, `file`이다.
P0 `AnalysisType`은 IMAGE/TEXT/URL이지만 TEXT/URL은 현재 400으로 거부한다.
TEXT/URL 요청의 오류 메시지는 현재 IMAGE만 지원한다는 점을 명시한다.
JPEG(`image/jpeg`, `.jpg`/`.jpeg`)와 PNG(`image/png`, `.png`)만 허용한다.
MIME, 확장자, 파일 시그니처 및 크기를 확인한다. 전체 이미지 디코딩 검증은 실제 Provider 연결 시 필요하다.
`ANALYSIS_MAX_FILE_BYTES`로 상한을 설정한다. `.env.example`의 10 MiB는 개발 제안값이며 운영 정책 확정이 필요하다.

```bash
curl -X POST http://localhost:3000/api/analysis \
  -F 'type=IMAGE' -F 'file=@sample.png'
```

### 처리 및 응답

type/파일 검증 → Analysis(QUEUED) 생성
→ Usage 예약 연동 지점 → ANALYZING → Provider 호출/검증 → 모델별 결과·최종 상태 트랜잭션 저장
→ 원본 메모리 정리 → 응답.

각 요청은 Provider 실행과 결과 저장을 기다리는 구조다. 성공 HTTP 상태는 요청 계약에 맞춰 202를 사용한다.
같은 이미지를 다시 보내도 매번 새 분석 요청으로 처리한다.
별도 작업 큐나 백그라운드 작업은 구현하지 않았다. GET 조회 API는 후속 범위다.

```json
{
  "isSuccess": true,
  "code": "ANALYSIS202",
  "message": "분석 요청 생성에 성공했습니다.",
  "result": {
    "analysisId": "<uuid>",
    "type": "IMAGE",
    "status": "COMPLETED",
    "aiGenerationScore": 82.4,
    "aiRiskLevel": "CAUTION",
    "reasons": [
      { "description": "AI 생성·변조 가능성과 관련된 특징이 감지되었습니다." }
    ],
    "modelVersion": "<provider-model-version>",
    "errorCode": null,
    "createdAt": "2026-10-04T00:00:00.000Z",
    "completedAt": "2026-10-04T00:00:01.000Z",
    "expiresAt": "2026-10-05T00:00:00.000Z"
  }
}
```

이 예시는 레거시 응답 계약 설명용이다. 개발 Mock의 현재 값은 아래 Issue #6 절을 따른다. 운영에서는 Mock을 금지한다.
실제 Provider 미연동 시 FAILED 저장 후 HTTP 503 / ANALYSIS503을 반환한다.
`aiGenerationScore`는 0~100의 AI 생성·변조 가능성으로 사기/피싱 확률과 분리한다.
`aiRiskLevel`은 Provider의 문자열이며 enum/점수별 경계는 계약 확정 TODO다.
확정적인 AI 여부 판정, fraudScore, totalScore는 생성하지 않는다.
`reasons`는 description 배열이며, 별도 category가 명세에 없으므로 만들지 않는다.
Provider가 추가 필드를 반환해도 정의된 결과 필드와 근거의 description만 저장·반환한다.
status는 QUEUED/ANALYZING/COMPLETED/FAILED이다.
점수·위험 수준·근거·모델 버전·errorCode·completedAt은 처리 상태에 따라 nullable이다.

### 오류

공통 형식: `{ "isSuccess": false, "code": "COMMON400", "message": "...", "result": null }`.
Analysis Controller에만 필터를 적용해 기존 Health 응답은 유지한다.

| HTTP | code        | 상황                                                |
| ---- | ----------- | --------------------------------------------------- |
| 400  | COMMON400   | type/file 누락, IMAGE 이외의 type, 잘못된 multipart |
| 413  | COMMON413   | 크기 초과                                           |
| 415  | COMMON415   | MIME/확장자/시그니처 불일치                         |
| 429  | USAGE429    | 이용량 초과 (Usage 연동 후 실제 적용)               |
| 503  | ANALYSIS503 | Provider 미연동/장애/잘못된 결과/타임아웃/모두 실패 |
| 500  | COMMON500   | DB 저장 실패, 내부 오류, 정책/인증 설정 누락        |

### DB·개인정보

클라이언트의 `Idempotency-Key` 헤더는 사용하지 않는다. 재전송도 별도의 분석 요청으로 처리한다.
분석 요청은 id 기본키로 구분한다. idempotencyKey 컬럼과 사용자/키 복합 UNIQUE는 제거했다.
IMAGE 유형+MIME+이미지 바이트 SHA-256을 requestHash로 저장하지만 중복 요청 비교에는 사용하지 않는다.
결과를 저장하는 DB 장애가 계속되거나 프로세스가 종료되면 QUEUED/ANALYZING 상태가 남을 수 있다.
해당 상태의 복구 작업은 작업 큐/재시도 정책과 함께 후속 구현한다.

원본 이미지와 파일 이름은 DB/디스크에 저장하지 않는다. 메모리 버퍼는 성공·실패·검증 실패 후 정리한다.
검증 이전 multer 거부 시 버퍼는 요청 종료 후 해제된다. 이미지/토큰/민감정보를 로그에 출력하지 않는다.
현재 userId는 임시 값 `development-user`로 저장하며 Auth/User 연동 후 인증 사용자 ID와 FK를 연결한다.
분석 근거는 최소 데이터로 JSON에 저장하며 실제 Provider가 원본 개인정보를 근거에 재출력하지 않도록 계약을 확정해야 한다.
`ANALYSIS_RETENTION_SECONDS`로 expiresAt을 기록한다. 개발 예시 24시간은 확정 정책이 아니다.
자동 삭제, 기록 저장 동의은 미구현이며 운영 전 확정이 필요하다. expiresAt 경과 자체가 재분석/차감을 유발하지 않는다.

### 연동 TODO

- `IMAGE_ANALYSIS_PROVIDER`: 개발 Mock은 구현. 실제 HTTP AI Provider는 후속 구현.
- `AnalysisUsageService`: IMAGE 1회 예약/차감. analysisId 기준 중복 방지와 실패 복구를 실제 Usage 시스템에 연결. 현재 차감 없음.
- 실제 Usage와 Analysis 간 원자성/실패 복구 정책 확정. 구독 시스템은 이번 범위에서 구현하지 않음.
- aiRiskLevel enum, 인증 issuer/audience, 파일 크기, 기록 동의·보관·삭제 정책 확정.
- TEXT/URL 분석과 GET /api/analysis/{analysisId}는 후속 구현.

### 설치/검증

```bash
npm install
cp .env.example .env
# JWT_ACCESS_SECRET을 안전한 실제 값으로 설정하고 DATABASE_URL 확인
npm run prisma:generate
npm run prisma:migrate
npm run build
npm run typecheck
npm test -- --runInBand
```

API 통합 테스트는 Nest/multipart/Swagger를 실제 실행하고 Repository/Provider/Usage를 테스트 대역으로 교체한다.
실제 PostgreSQL 통합 및 실제 AI Provider 테스트와는 구분한다.

## BE→AI 내부 API v1 데이터 구조 준비

대상 내부 엔드포인트는 `POST /internal/v1/image-analyses`이다. 실제 HTTP 호출은 아직 구현하지 않았다.
`image-analysis-v1.dto.ts`에 AI wire 타입과 BE 공개 projection 타입을 분리하고,
`ImageAnalysisService.validateV1Response`에 알려진 계약 규칙 검증 진입점을 마련했다.
기존 `POST /api/analysis` 요청·응답·HTTP 상태·파일 검증·인증 임시 비활성화 상태는 유지한다.
GET 상세 조회는 기존에도 미구현이며 이번 작업에서도 추가하지 않는다. 멱등성 키는 이전 제거 상태를 유지한다.
Swagger components에 새 projection을 등록했지만 현재 POST 응답에 이를 추가하지 않는다.

### 상태와 저장 구조

- BE 작업 상태: 기존 QUEUED/ANALYZING/COMPLETED/FAILED 유지.
- AI 집계 상태: 별도 nullable `Analysis.imageResultStatus`에 COMPLETED/PARTIAL_FAILED/FAILED 저장.
- 모델 실행 상태: 별도 `AnalysisModelResult.status`에 SUCCEEDED/FAILED 저장.
- 판정은 실행 상태와 별개이며 INCONCLUSIVE 허용.
- 기존 aiGenerationScore/aiRiskLevel/reasons/modelVersion/errorCode는 유지한다. 새 점수를 합산하거나 기존 위험 단계로 임의 변환하지 않는다.
- `analysis_model_results`는 Analysis와 FK/Cascade 관계, `(analysisId, kind)` UNIQUE로 generation/manipulation 결과를 구분한다.
- 모델별 상태/정수 표시 점수/판정/근거/한계/모델·정책 버전/오류 코드/nullable retryable 저장.
- 별도 테이블을 선택한 이유: 모델별 독립 갱신, UNIQUE/FK/점수 CHECK 및 트랜잭션 무결성을 적용하기 위해서다. 근거는 기존 BE description 배열을 JSON으로 저장한다.
- rawScore, analysisImage, 원본/crop, localization PNG/base64, error 원문은 신규 저장 whitelist에서 제외한다.
- requestHash/expiresAt 및 원본 버퍼 정리 정책은 유지한다. 자동 TTL 삭제는 기존에도 미구현이다.

### Repository 재사용 메서드

- `saveModelResults(analysisId, result)`: AI wire 객체가 아닌 BE 정규화 projection을 받는다. 모델 upsert와 집계 상태를 트랜잭션으로 저장한다. null 모델은 upsert하지 않아 기존 결과를 유지한다.
- `findWithModelResults(id)`: 기존 메타데이터/레거시 결과와 모델별 결과·요약 필드 조회. HTTP 조회 API가 아니며 이후 호출자가 인증·소유권·만료를 확인해야 한다.
- imageResultStatus는 최근 전달한 AI 응답의 집계 상태이고 modelResults에는 이전 요청에서 보존된 모델 결과도 있을 수 있다. 재시도·다중 실행 집계 정책은 추후 합의한다.
- `saveSummary(id, value)`: null(미생성), PENDING(작업 시작), COMPLETED, FAILED를 구분한다. Gemini 호출/자동 요약/큐/재시도는 구현하지 않았다.
- Mock 흐름에서 부분 성공은 BE COMPLETED + AI PARTIAL_FAILED, 모두 실패는 BE FAILED + AI FAILED로 저장한다.

### Migration

`20261012000000_image_analysis_v1`은 enum/모델별 테이블과 nullable 필드를 추가한다.
기존 데이터 삭제/초기화 없음. 신규 요약 필드는 모두 null이며 PENDING을 일괄 부여하지 않는다.
운영 DB에는 직접 적용하지 않았다. 이전 멱등성 키 삭제 migration은 별도 변경으로 유지한다.

### AI팀과 합의가 필요한 항목

- contractVersion의 정확한 리터럴, sourceType와 requestedModels enum 및 선택자→모델 대응.
- elementId의 타입과 null 허용 여부.
- analysisImage, rawScore, reasons, limitations, error의 실제 중첩 구조/필수·nullable 필드.
- localization PNG_BASE64 discriminator/PNG 필드명·크기·좌표·인코딩 및 수명.
- 실패 모델에서 decision/버전 필드가 항상 존재하는지 여부.
- retryable의 실제 위치·필드명. 미확정이면 null로 보존한다.
- 근거·한계 wire 데이터에서 BE 공개 projection으로의 명시적 변환.
- aiRiskLevel 매핑, 미요청 모델 판별, requestId/analysisId 연계 검증과 부분 성공 후 BE 상태 전이.

미확정 wire 필드는 unknown/TODO로 표시했다. 현재 validator는 알려진 필수 키·상태·점수·오류 일치·generation localization=null 규칙을 검증하는 준비 단계이며, 완전한 AI 계약 검증은 아니다.

### 검증

- 기존 POST 호환성 및 Provider 실패 처리 테스트.
- 두 모델 성공/부분 성공/모두 실패, INCONCLUSIVE, null 점수·미요청 모델, 오류 코드 불일치·필수 필드 누락·잘못된 점수 검증.
- Repository whitelist·트랜잭션·null 모델 보존·null 요약 호환 테스트.
- `V1_DB_TEST=1 npm test -- --runInBand`: localhost DB에 임시 스키마를 만들어 초기 migration + v1 migration을 검증하고 종료 시 삭제한다. 운영 DB 연결은 거부한다.
- 일반 테스트에서는 DB 통합 테스트를 skip한다. `PSQL_PATH`로 psql 경로를 지정할 수 있다.

### 2026-10-13 실패 모델 nullable 규칙 보완

- FAILED: decision=null, displayScore=null 필수. errorCode와 error.code 일치 규칙 유지.
- SUCCEEDED: decision 필수. INCONCLUSIVE + displayScore=null도 정상 결과로 저장한다.
- 이미 적용된 `20261012000000_image_analysis_v1` 파일은 유지하고 `20261013000000_nullable_failed_model_decision`에서 decision nullable 및 상태별 CHECK를 추가한다.
- 기존 실패 행에 decision/점수가 남아 있으면 새 migration의 CHECK 검증이 실패한다. 자동 삭제·변환하지 않으며 적용 전 명시적 데이터 처리 정책이 필요하다.
- 확인한 설정 DB: 초기/멱등성 제거/v1 migration 적용 완료, 파일 checksum 모두 일치. 모델 결과 0건으로 새 제약 충돌 0건. 이번 작업에서 해당 DB에는 migration을 적용하지 않았다.
- `20261008000000_remove_analysis_idempotency_key`는 컬럼과 UNIQUE만 제거한다. API의 키 입력·검사 코드는 이전 작업에서 별도로 제거되어 현재 멱등성 기능은 없다. 이번 검토에서 복원하지 않는다.
- 격리 DB 테스트는 원본 migration 전체 체인을 순서대로 적용하고 Prisma diff와 실제 DB 제약을 각각 검증한다. Prisma diff가 CHECK를 완전히 표현하지 않으므로 CHECK는 직접 잘못된 값을 INSERT하여 별도로 검증한다.

## Issue #6: 개발용 Mock Provider 연동

실제 AI 서버와 Gemini는 호출하지 않는다. 아래 점수·근거는 고정 가상 fixture이며 실제 모델의 성능/정확도/위험도를 의미하지 않는다.

### 개발 설정

기존 .env에 아래 값을 추가한 후 서버를 재시작한다. .env 전체를 덮어쓰지 않는다.

```env
AI_PROVIDER=mock
AI_MOCK_SCENARIO=BOTH_SUCCESS
AI_REQUEST_TIMEOUT_MS=30000
```

- AI_PROVIDER 생략 또는 unavailable: 기존 미연동 Provider, 503.
- mock: 개발/테스트 전용. NODE_ENV=production에서는 서버 시작 실패.
- http: HTTP 미구현 설정 오류를 503 / ANALYSIS503으로 명확히 반환.
- 알 수 없는 모드·Mock 시나리오·잘못된 제한 시간: 서버 시작 시 설정 오류.
- Mock 시작 로그에 MOCK/synthetic임을 표시한다. 이미지·토큰·민감한 입력은 기록하지 않는다.
- 기존 AI_SERVER_BASE_URL을 재사용한다. AI_SERVER_URL을 중복 추가하지 않았다.
- AI_SERVICE_TOKEN은 향후 HTTP용 예약 설정이며 현재 사용하지 않는다.
- Mock 시나리오는 서버 환경변수/테스트로만 선택한다. FE 요청에 시나리오 필드는 없다.

### 요청과 결과

DB analysisId + 내부 생성 elementId/requestId UUID + file + sourceType=IMAGE + models=ALL + deadlineAt을 구성한다.
elementId는 현재 Element 모델이 없어 호출 단위 UUID로 관리하고 영구 저장하지 않는다.
Provider는 선택 모델과 응답의 ID·sourceType·requestedModels 대응을 검증한다.

| 시나리오            | AI 집계 상태    | BE 상태   | HTTP |
| ------------------- | --------------- | --------- | ---- |
| BOTH_SUCCESS        | COMPLETED       | COMPLETED | 202  |
| GENERATION_FAILED   | PARTIAL_FAILED  | COMPLETED | 202  |
| MANIPULATION_FAILED | PARTIAL_FAILED  | COMPLETED | 202  |
| BOTH_FAILED         | FAILED          | FAILED    | 503  |
| INCONCLUSIVE        | COMPLETED       | COMPLETED | 202  |
| TIMEOUT             | 결과 없음(null) | FAILED    | 503  |

양 모델 실패도 모델 결과를 먼저 보존하고 공통 오류 본문(result=null)을 반환한다. 타임아웃/전송 실패/잘못된 응답은 모델 결과 없이 실패 처리한다.
부분 성공에서 성공 모델을 삭제하지 않는다. 사용량 해제는 전체 요청 실패에 기존 정책을 적용하며 부분 실패는 별도 정책 확정이 필요하다.
서비스에서 기한을 강제하고 AbortSignal을 전달한다. 자동 재시도/큐는 없다.
DB 자체가 장애라 실패 상태 저장도 실패하거나 프로세스가 종료되면 ANALYZING이 남을 수 있다. 복구 큐/재시도는 이번 범위에 포함하지 않는다.

### 기존 FE 응답 유지

generation/manipulation/rawScore/localization/imageResultStatus를 POST 응답에 추가하지 않는다.
기존 응답의 status는 BE 작업 상태이며 부분 성공도 COMPLETED로 표시된다. FE에 부분 실패를 표현하는 새 필드는 별도 계약이 필요하다.

- aiGenerationScore: 성공한 CuRe displayScore만 사용. 보류/실패면 null.
- reasons/modelVersion: 성공한 CuRe의 근거/버전만 사용. CuRe 실패면 null.
- aiRiskLevel: 정책 미확정으로 null. TruFor 점수와 합산하거나 사기 위험도로 변환하지 않는다.
- TruFor의 상세 결과는 DB 모델별 조회 메서드로 확인한다. 새 GET API는 구현하지 않는다.
- 기존 레거시 Provider 검증·저장 경로는 보존한다. v1 응답은 기존 validator와 명시적 projection을 거친다.

### 초안과 최종 명세 구분

Mock은 contractVersion=1.0, requestedModels=[GENERATION, MANIPULATION], reasons=[{description}], limitations=string[], error.retryable을 fixture 규약으로 사용한다.
미확정 wire 타입은 기존 unknown/TODO를 유지한다. 위 fixture 규약이 AI팀 최종 명세임을 주장하지 않는다.
analysisImage/localization/rawScore는 Mock에서 null이며 원본/crop/rawScore/heatmap/base64는 DB에 저장하지 않는다.

### 실제 HTTP 전환 시 작업

Http Provider를 구현하고 선택 factory의 http 분기에 연결한다. 기존 AI_SERVER_BASE_URL, AI_SERVICE_TOKEN, AI_REQUEST_TIMEOUT_MS를 사용한다.
AI팀과 endpoint/인증 헤더/multipart 필드/contractVersion/중첩 필드/요청 모델 선택자/오류 규약을 확정하고 adapter projection 및 검증을 맞춘다.
기존 FE 상태·위험도·부분 실패 노출 정책과 사용량 정책은 별도 합의가 필요하다.

### 검증 명령

```bash
npm run typecheck
npm run build
npm test -- --runInBand
# 실제 로컬 PostgreSQL: 임시 스키마 생성/삭제, 기존 public 데이터 변경 없음
V1_DB_TEST=1 npm test -- --runInBand
```

API 검증은 Repository 대역을 사용하고, DB 검증은 실제 AnalysisService→Mock→Prisma 흐름을 임시 스키마에서 수행한다.
실제 AI 서버 통신·모델 결과·Android 화면은 검증하지 않았다. 기존 migration/Prisma 스키마 변경은 없다.

## Issue #6 v0.2 변경 사항 — CuRe + TruFor

이 절이 이전 Mock 초안의 모델/판정 규칙을 대체한다. contractVersion은 `1.0`이고 모델 이름은 CuRe/TruFor다.
실제 추론이나 HTTP 요청 없이 고정 rawScore fixture와 `*-mock-v0.2` 모델 버전을 사용한다.

### 파일 역할

- image-analysis-v1.dto.ts: 기존 v1 타입을 재사용하고 decisionLabel/overallResult 포함 v0.2 타입 및 PNG 구조를 확장.
- image-analysis-policy.ts: CuRe/TruFor 임시 파일럿 판정·표시 점수·대표 판정 순수 함수.
- image-localization.validator.ts: PNG base64/크기/비율/좌표계/실제 디코딩 검증.
- image-analysis-v1.validator.ts: 기존 공통 검증을 유지하고 v0.2 추가 규칙 검증.
- mock-image-analysis.provider.ts: v0.2 fixture 생성, 기존 DI·운영 Mock 차단 유지.
- image-analysis.service.ts: v0.2 검증 후 기존 저장 projection으로 변환. rawScore/localization/overallResult는 영구 저장이나 공개 POST 응답에 포함하지 않는다.
- 관련 API/Mock/v0.2/격리 DB 테스트: 기존 회귀 테스트와 신규 정책·PNG·재요청 검증.
- package.json/package-lock.json: pngjs 및 TypeScript 타입 추가.

### 파일럿 정책

| 모델   | 신호 없음        | 판단 불가               | 의심         |
| ------ | ---------------- | ----------------------- | ------------ |
| CuRe   | score < 0.000004 | 0.000004 ≤ score < 0.02 | score ≥ 0.02 |
| TruFor | score < 0.12     | 0.12 ≤ score < 0.70     | score ≥ 0.70 |

반올림 전 원점수로 판정한다. 표시 점수는 floor(score * 100 + 0.5), INCONCLUSIVE 또는 FAILED면 null.
실패 모델은 rawScore/displayScore/decision/decisionLabel/localization=null, reasons/limitations=[]이며 오류 정보를 유지한다.
이 점수는 사기 확률이나 모델 정확도 주장이 아니다. SAFE/CAUTION/DANGER로 변환하지 않는다.

### 대표 판정

calculateOverallResult(generation, manipulation)는 Prisma에서 읽은 status/decision으로도 재사용 가능하다.
의심 성공 모델이 있으면 생성·변조 의심, 아니면 보류/실패/미요청 모델이 있으면 판단 불가,
두 모델이 모두 성공하고 신호 없음이면 뚜렷한 신호 없음이다. 모델 식별자 배열 순서는 generation→manipulation이다.
policyVersion=image-overall-v1이며 대표 점수는 없다. 실행 상태와 별개의 판정이다.
미요청 null은 해당 AI 응답에서는 uncertainKinds에 포함되지만, 기존 DB 성공 결과를 삭제하지 않는다.
모델 한 개 재요청 후 DB의 누적 결과를 기반으로 대표 판정을 계산하면 해당 재요청 응답의 대표 판정과 달라질 수 있다.
대표 결과 저장용 컬럼/테이블은 추가하지 않았다.

### Mock 시나리오

기존 BOTH_SUCCESS/GENERATION_FAILED/MANIPULATION_FAILED/BOTH_FAILED/INCONCLUSIVE/TIMEOUT을 유지한다.
BOTH_SUCCESS는 두 모델 의심, INCONCLUSIVE는 CuRe 보류 + TruFor 의심이다.
NO_CLEAR_SIGNAL(두 모델 신호 없음), BOTH_INCONCLUSIVE(두 모델 보류), LOCALIZATION(1×1 정상 PNG 지도)을 추가했다.
GENERATION/MANIPULATION 단독 요청은 내부 테스트의 request.models로 설정한다. 공개 FE 파라미터를 추가하지 않는다.
두 모델 보류도 root COMPLETED이며, 요청 모델만 대상으로 COMPLETED/PARTIAL_FAILED/FAILED를 계산한다.

### Localization

CuRe localization은 null, TruFor는 null 또는 PNG_BASE64/MANIPULATION_HEATMAP/image/png/ANALYSIS_IMAGE 구조다.
base64 최대 1,398,104자, decoded PNG 최대 1 MiB, 지도 긴 변 최대 1024를 검사한다.
imageSize와 mapSize 비율은 정수 교차곱으로 검사하고 IHDR 크기 확인 후 pngjs로 CRC 및 실제 디코딩을 검증한다.
PNG fixture는 실제 디코딩 가능한 작은 이미지이며 저장/로그/FE 전송/URL 생성은 하지 않는다.

### 요청과 후속 HTTP 교체

Mock 요청에서도 analysisId/elementId UUID, requestId UUID v4, 미래 UTC RFC3339 deadlineAt을 검사한다.
현재 elementId는 요청 컨텍스트에서만 관리하며 crop/Element DB 모델은 추가하지 않는다.
향후 Http Provider를 선택 factory에 연결하고 Authorization 서비스 토큰·X-Request-ID·multipart 파일 전송을 구현한다.
기존 AI_SERVER_BASE_URL/예약 AI_SERVICE_TOKEN 설정은 현재 네트워크에 사용하지 않는다.
최종 analysisImage/reasons/limitations/error 상세 계약과 decisionLabel 정확한 문구·모델 policyVersion은 AI팀 확인이 필요하다.
현재 labels/정규화 근거/버전은 명시적 Mock fixture이며 실제 GPU 결과와 구분한다.

### 범위

기존 공개 POST 응답·인증 임시 비활성화·development-user·멱등성 제거 상태 유지.
기존 Prisma 스키마와 migration 변경 없음. 모델별 저장 whitelist 및 UNIQUE/부분 성공 보존 유지.
실제 HTTP/추론/Gemini/FE 확장/heatmap 저장/SCREEN crop/큐·재시도/quota 구현 없음.
