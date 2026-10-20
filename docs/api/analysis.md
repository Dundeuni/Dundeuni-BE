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
- http: #10 HTTP 어댑터. 서버 URL·Bearer 토큰 필수. 실제 서버 검증은 AI팀 정보 수신 후 별도 진행.
- 알 수 없는 모드·Mock 시나리오·잘못된 제한 시간: 서버 시작 시 설정 오류.
- Mock 시작 로그에 MOCK/synthetic임을 표시한다. 이미지·토큰·민감한 입력은 기록하지 않는다.
- 기존 AI_SERVER_BASE_URL을 재사용한다. AI_SERVER_URL을 중복 추가하지 않았다.
- AI_SERVICE_TOKEN은 http 모드에서 Bearer 인증에 사용한다. mock에서는 사용하지 않는다.
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


## Issue #94 POST→Mock→DB 저장·Repository 재조회 검증

검증 범위는 `POST /api/analysis` → 업로드/DTO 검증 → QUEUED 생성 → Usage 예약
→ ANALYZING → CuRe·TruFor Mock 호출 → v0.2 응답 및 요청 ID/모델 대응 검증
→ 저장 projection → 모델 upsert·Analysis 상태·completedAt의 트랜잭션 저장
→ 기존 `AnalysisRepository.findWithModelResults(id)` 재조회다.
GET API·새 Controller·Gemini 요약·History API·Prisma 스키마/migration은 추가하거나 변경하지 않는다.
기존 POST `202 / ANALYSIS202`와 공개 응답 필드를 유지한다.

Mock 시나리오에 GENERATION_SUSPECTED(CuRe만 의심), MANIPULATION_SUSPECTED(TruFor만 의심)를 추가했다.
기존 시나리오와 저장/판정 구현은 검증 결과 정상으로 유지한다.
성공한 모델 중 의심이 있으면 기존 내부 판정 GENERATION_OR_MANIPULATION_SUSPECTED,
의심 없이 실패·미요청·판단 불가가 있으면 INCONCLUSIVE,
두 모델 모두 성공하고 신호가 없으면 NO_CLEAR_SIGNAL이다. 점수를 평균·합산하지 않는다.
종합 판정은 별도 DB 컬럼에 저장하지 않으며 재조회한 모델 결과로 계산해 Mock 응답과 비교한다.
모델 이름은 기존 필드 modelName(CuRe/TruFor)을 사용한다.

부분 실패는 성공 모델과 실패 모델 모두 저장하고 POST 202, imageResultStatus=PARTIAL_FAILED다.
전체 모델 실패는 두 실패 모델 결과와 FAILED/ANALYSIS503/completedAt을 저장하고 POST 503이다.
타임아웃은 모델 결과 없이 FAILED/ANALYSIS503/completedAt을 저장하고 POST 503이며 호출을 abort한다.
rawScore/localization은 저장 projection 및 POST 공개 응답에서 제외한다.
`(analysisId, kind)` UNIQUE와 upsert로 반복 저장 시 행 수와 모델 ID를 유지한다.

### 검증 방법

`V1_DB_TEST=1 npm test -- --runInBand`는 localhost PostgreSQL 임시 스키마에서 실제 POST와
Prisma 저장·Repository 재조회를 실행하고 종료 시 임시 스키마를 삭제한다.
두 모델 정상/각 모델만 의심/모두 의심/신호 없음/각 모델 실패/전체 실패/판단 불가/타임아웃,
반복 저장과 최신 값 재조회, 없는 ID의 null 반환을 검증한다.
모델별 analysisId·modelName·status·decision·displayScore·reasons·limitations·오류 정보와
Analysis 상태·completedAt을 실제 Mock 반환 값 및 POST 응답과 비교한다.
기존 migration·DB 제약·트랜잭션 롤백·부분 재요청 결과 보존 테스트도 유지한다.
실제 AI 서버는 호출하지 않는다. GET API 미구현은 #94 실패 사유가 아니다.

### #89에서 처리할 조회 API 항목

- 분석 상세 GET Endpoint, 공개 응답 DTO 및 Swagger 계약 정의·구현.
- 인증 사용자와 분석 소유권 검증, 없는 ID 및 잘못된 ID의 오류 계약.
- 모델별 저장 결과와 종합 판정의 공개 형식, 내부 의심 판정의 공개 enum 매핑 확정.
- rawScore·원본 이미지·내부 식별자 비노출, 레거시/진행 중/실패/타임아웃 데이터 조회 처리.
- 보관 기한과 접근 정책, 조회 API 통합 테스트.

위 목록은 #94에서 확인한 조회 API 후속 항목이며 #89의 기존 명세와 대조해 확정해야 한다.


## #10 AI 연동 — HTTP Provider 및 v0.2 wire 계약 보완

이 절이 이전 Mock 초안의 wire 형식·HTTP 미구현 설명을 대체한다.
사용자가 제공한 「AI 이미지 분석·입출력 명세서 v0.2」(AI 구현 d6b591b·API 명세 6eaf062 기준)에 맞춘다.
실제 서버 주소·토큰이 확인되지 않아 실서버 호출은 하지 않았으며 로컬 HTTP Mock만 사용한다.

### 전환과 전송

- `AI_PROVIDER=mock`: 기존 개발용 Mock 유지. production Mock 금지 정책 유지.
- `AI_PROVIDER=http`: 새 HttpImageAnalysisProvider. `AI_SERVER_BASE_URL`, `AI_SERVICE_TOKEN` 필수.
  토큰이 없으면 시작 시 오류를 내며 무인증 호출로 대체하지 않는다.
- 생략 또는 `unavailable`: 기존 미연동 503 유지. `real`이라는 새 모드명은 추가하지 않는다.
- 설정 주소의 origin에 `POST /internal/v1/image-analyses`를 동기 multipart로 전송한다.
- 헤더: `Authorization: Bearer <AI_SERVICE_TOKEN>`, `X-Request-ID: <UUID v4>`.
- multipart 필드: `file`, `analysisId`, `elementId`, `sourceType`, `models`, `deadlineAt`.
  requestId는 multipart에 중복 추가하지 않는다. 전송 파일명은 원래 사용자 파일명 대신 고정 이름을 사용한다.
- sourceType은 IMAGE/SCREEN_CROP, models는 ALL/GENERATION/MANIPULATION이다.
  기존 AnalysisService가 UUID·미래 UTC 마감·기본 ALL을 생성한다.
- file은 JPEG/PNG, 10 MiB 이하이며 직렬화된 multipart 전체는 11 MiB 이하로 검사한다.
  이미지 변 32~8192 px·총 16,000,000 px·단일 프레임·EXIF/RGB/알파 정규화는 AI 서버의 책임이다.
  이 어댑터에서 별도의 이미지 재인코딩·crop을 하지 않는다. 입력 오류의 4xx를 처리한다.
- HTTP redirect는 따르지 않아 Bearer·파일이 다른 주소로 자동 전송되지 않는다.

### 응답 검증 및 기존 저장 구조 재사용

| 항목 | v0.2 처리 |
| --- | --- |
| contractVersion | 문서 버전과 별개로 문자열 `1.0` |
| requestedModels | 소문자 generation/manipulation, 순서·중복·선택 모델과 null 객체 대응 검증 |
| rawScore | 성공 시 `{score: number}`(0~1), 실패 null. 숫자 단독 형식 거부 |
| reasons | 문자열 배열 최대 5개, 판단 불가/실패는 빈 배열 |
| limitations | 문자열 배열 최대 8개, 실패는 빈 배열 |
| failed error | errorCode=error.code, message 문자열, retryable boolean 필수 |
| analysisImage | inputSha256·정규화 크기·normalizationVersion 검증. 해시를 보낸 파일 바이트와 비교 |
| model status/decision | 기존 파일럿 임계값과 displayScore 규칙 검증. 판단 불가도 SUCCEEDED |
| 전체 상태/overallResult | 모델 실행 상태와 종합 판정 정책을 각각 검증. 점수 합산 없음 |
| localization | 흑백 PNG·base64·1 MiB·긴 변 1024·이미지 크기 연계·CRC/디코딩 검증. 종횡비는 정수 반올림 허용 |
| 내부 출력 | 모델 객체의 map/conf/imgsize 거부. rawScore/localization은 저장/공개 projection에서 제외 |

v0.2에 모델 이름 필드가 필수로 제시되어 있지 않으므로 HTTP 응답 modelName을 요구하지 않는다.
기존 Mock의 modelName은 호환성을 위해 유지하고, 제공될 경우 CuRe/TruFor 대응을 확인한다.
DB 및 기존 공개 projection의 modelName은 generation=CuRe, manipulation=TruFor로 결정한다.
문자열 reasons는 `{description}` 배열로 변환해 기존 Repository completeV1 경로로 저장한다.
기존 POST 202/ANALYSIS202, 부분 실패 보존, 전체 모델 실패 503, DB 구조를 유지한다.

### 오류·타임아웃·재시도 경계

AI 정상 envelope는 HTTP 200만 허용한다. 모델 실패도 envelope 검증 후 기존 흐름대로 저장한다.
요청 오류 400/422는 COMMON400, 413은 COMMON413, 415는 COMMON415로 처리한다.
AI 서비스 인증 오류 401/403은 사용자 인증 오류가 아니므로 ANALYSIS503으로 처리한다.
429/5xx/redirect·네트워크·timeout·JSON/envelope/컨텍스트 불일치도 기존 ANALYSIS503으로 처리한다.
AI 오류 본문·서비스 토큰·내부 stack은 공개 응답이나 로그에 복사하지 않는다.

기존 `AI_REQUEST_TIMEOUT_MS=30000` 기본값을 임의 변경하지 않는다.
HTTP 어댑터와 기존 서비스는 설정 예산/미래 deadlineAt 중 빠른 마감에 맞춰 중단하며 AbortSignal을 전파한다.
명세 개발 설정의 모델당 120초 + 순차 ALL + 응답 여유 1초는 최악 실행에 최소 241000ms가 필요하다.
실서버 전환 전에 BE/AI/프록시/세션 TTL 예산을 합의하고 환경별 설정을 맞춰야 한다.

HTTP 전송 자체의 자동 재시도는 없다. 실패 모델만 선택한 요청 컨텍스트는 지원하지만,
재시도 스케줄·총 예산과 해시/정규화/정책 버전/현재 시도를 확인한 병합 orchestration은 추가하지 않았다.
현재 DB projection은 normalizationVersion/입력 크기/현재 시도를 보관하지 않으므로,
기존 단일 모델 upsert 보존을 완전한 v0.2 재시도 병합 검증으로 설명하지 않는다.
이 기능은 별도 저장/수명 정책 합의가 필요하다. AI 내부 retry·캐시는 구현하지 않는다.

### 검증 및 실서버 전환에 필요한 정보

로컬 HTTP 서버로 정확한 endpoint·Bearer·추적 헤더·multipart 필드/파일 바이트와 응답 projection을 검증한다.
추가 HTTP Mock 테스트는 상태코드별 오류 매핑·잘못된 envelope·네트워크·timeout·취소·설정 누락,
v0.2 원점수/문자열 근거/메타데이터/지도 반올림 및 해시 불일치를 검증한다.
기존 Mock→Service→Prisma 저장 회귀 테스트도 실행한다. .env는 변경하지 않는다.

실서버 검증에 필요한 정보:

1. AI팀이 확인한 실제 AI_SERVER_BASE_URL과 HTTP/HTTPS·네트워크 접근 방법.
2. 유효한 AI_SERVICE_TOKEN(채팅·저장소 대신 서버 비밀 설정 또는 .env에 입력).
3. 비민감 테스트 이미지와 사용 승인, 정상/실패/부분 실패 예상 결과.
4. BE/AI/프록시/세션 TTL·재시도 예산 합의 및 실제 배포 버전.
5. 재시도 병합 시 필요한 정규화·정책·현재 시도 검증과 보관 정책.

실제 GPU 모델 실행 순서/소요시간/인증/동시 요청/입력 제한/최종 지도 품질과 운영 부하는 미검증이다.
명세의 요청/응답 어댑터 검증과 실제 BE·AI·DB 통합 검증을 구분한다.


### #6 PR과의 분리

#10 변경은 `feature/#10-ai-integration`에서 관리한다. 기준 커밋은 #6의 `049dc09`이며,
기존 미커밋 14개 파일을 내용 변경 없이 이 브랜치로 옮긴 뒤 Swagger 및 HTTP 부분 실패 테스트를 보완했다.
기존 #6 브랜치/PR에 commit·push하지 않는다. 실제 AI 주소·토큰 확인과 실서버 E2E는 별도 진행한다.

### 로컬 실서버 테스트 준비 (외부 호출 보류)

현재 .env는 변경하지 않는다. Railway CLI 설치·로그인·배포·환경변수 변경도 수행하지 않는다.
실제 외부 AI 호출은 테스트 이미지와 인증 설정 확인 후 별도 승인으로 진행한다.

후보 이미지: `test/fixtures/non-sensitive-pattern-256x192.png`.
로컬에서 생성한 256×192 단일 프레임 패턴 PNG(1,097 bytes)로 사람·사진·개인정보·EXIF가 없다.
기존 테스트의 1×1 PNG와 달리 AI 입력 크기를 충족한다. 전송/디코딩 확인용이며
실제 사진이나 생성·변조 판정 정확도 검증용이 아니다. 특정 모델 점수를 기대하지 않는다.

네트워크 없는 사전 점검:

```bash
node scripts/analysis-local-smoke.cjs
```

스크립트는 기본 dry-run이며 이미지 크기/CRC와 설정 준비 여부만 출력한다.
서버 주소의 실제 값이나 Bearer 토큰은 출력하지 않는다. .env에 쓰지 않는다.
설정 준비 여부는 실행 시 출력되는 boolean과 provider/timeout으로 확인한다. 문서에 기록된 과거 설정을 현재 상태로 간주하지 않는다.
ALL 개발 예산은 최소 241000ms이고 통신 여유까지 합의해야 한다.

실제 AI 호출 승인 후 절차:

1. 실제 배포 버전과 AI URL·토큰·테스트 이미지 사용을 확인한다.
2. 사용자가 승인한 환경 설정에서 AI_PROVIDER=http, AI_SERVER_BASE_URL, AI_SERVICE_TOKEN,
   AI_REQUEST_TIMEOUT_MS를 준비한다. 이 문서/스크립트에 토큰을 기록하지 않는다.
3. 같은 환경으로 로컬 BE를 시작/재시작한다. DB 저장을 확인할 수 있는 로컬 개발 DB를 사용한다.
4. 아래 명령은 로컬 BE의 POST /api/analysis에 전송하며 **BE가 외부 AI를 호출할 수 있다**.

```bash
node scripts/analysis-local-smoke.cjs --execute
# 다른 승인된 PNG를 선택하려면 --file <local-path>
# 로컬 BE 포트가 다르면 --be-url http://127.0.0.1:<port>/api/analysis
```

스크립트의 목적지는 loopback HTTP만 허용하고 redirect를 따르지 않는다.
공개 BE 응답의 202/ANALYSIS202와 분석 상태/점수만 요약 출력한다.
실행 중인 BE가 설정을 다시 읽었는지는 스크립트가 보증하지 않으므로 반드시 재시작/설정 확인이 필요하다.
이 브랜치에는 상세 GET이 없으므로 모델별 결과는 로컬 Repository/DB에서 별도 확인한다.
rawScore·지도·인증 정보·공급자 오류 본문을 스크립트가 출력하지 않는다.

### 실제 결과가 Prisma Studio에서 보이지 않을 때

`Analysis`는 PostgreSQL의 `analysis_requests`, `AnalysisModelResult`는
`analysis_model_results`에 매핑된다. HTTP와 Mock은 동일한 정규화/Repository 저장 경로를 사용한다.
`completeV1`은 모델별 upsert와 분석 상태 갱신을 하나의 트랜잭션으로 처리하며,
저장 실패를 성공 202로 무시하지 않는다. HTTP 실패 시 Mock 자동 전환은 없다.

Prisma Studio에서 기존 필터를 지우고 새로고침한 뒤 POST 응답의 `analysisId`를
`Analysis.id`와 `AnalysisModelResult.analysisId`에서 각각 검색한다.
모델별 두 행의 `kind`는 `GENERATION`/`MANIPULATION`이다.
생성 점수가 `null`이거나 reasons가 빈 배열이어도 `INCONCLUSIVE`이면 정상 저장 결과다.
`aiRiskLevel`은 현재 매핑하지 않으므로 null이며, 이 값으로 저장 실패를 판단하지 않는다.

`overallResult`는 별도 컬럼/JSON으로 영구 저장하지 않는다. 저장된 두 모델의
status/decision으로 `calculateOverallResult`를 호출해 복원한다. POST 공개 응답에도 포함하지 않는다.

로컬 BE와 같은 디렉터리/환경의 DB에서 새 요청 결과를 Repository로 즉시 재조회:

```bash
node scripts/analysis-local-smoke.cjs --execute --verify-db
```

이미 받은 analysisId만 읽기 전용 재조회(AI 호출 없음):

```bash
node scripts/analysis-local-smoke.cjs --verify-db --analysis-id <analysisId>
```

DB 검증은 모델별 안전한 필드와 복원한 종합 판정을 출력한다. 같은 ID가 없거나 두 모델 행이
없으면 실패한다. 이 조회만으로 HTTP Provider 실행을 증명하지는 않으며,
실행 프로세스의 provider와 실제 upstream 호출은 별도로 확인해야 한다.
BE와 Studio는 시작 시의 환경변수가 `.env`보다 우선하므로 같은 폴더에서 실행했어도
서로 다른 DB를 사용할 수 있다. 연결 문자열을 출력하지 않고 연결 대상과 schema의 일치 여부를 비교한다.

Railway 검증에는 공개 BE URL, 프로젝트/서비스/환경, 접근 권한, 배포된 commit/HTTP Adapter 여부,
AI 환경변수와 프록시 timeout 설정, 승인된 테스트 이미지가 필요하다.
Railway 주소·권한을 받기 전에는 로컬 검증을 Railway 검증으로 보고하지 않는다.

## PB-23 보완 (2026-10-19, 이전 멱등성 제거 설명을 대체)

선택적 `Idempotency-Key` 헤더를 지원한다. 1~128자의 공백 없는 ASCII 문자열이며
현재 임시 사용자 `development-user` 범위로 적용된다. 실제 인증은 구현하지 않았다.
요청 내용은 기존 requestHash(IMAGE + MIME + 이미지 바이트 SHA-256)로 비교한다.
파일명은 요청 내용에 포함하지 않는다. 키 없이 요청하면 매번 새 분석이다.

| 동일 사용자/키의 상태 | 응답 및 실행 정책 |
| --- | --- |
| 다른 요청 내용 | 409 COMMON409 |
| 만료됨 | 409 COMMON409, 새 키 필요 |
| QUEUED / ANALYZING | 409 COMMON409, 같은 키로 나중에 재요청 |
| COMPLETED | 기존 분석의 202/ANALYSIS202 응답 재사용 |
| FAILED | 저장된 오류 코드/상태를 재사용, 일반화된 실패 메시지 |

서로 다른 키는 동일 이미지여도 별도 실행한다. 실패 후 새 실행에는 새 키가 필요하다.
처리 중에 202 미완료 결과를 반환하지 않으므로 기존 동기식 성공 응답 필드를 유지한다.
DB unique(userId, idempotencyKey)의 insert 성공자만 AI/사용량 예약을 실행한다.
충돌자는 기존 행만 조회하며 자동 재시도·추가 AI 호출을 하지 않는다.
키는 분석 보관 수명 동안 유지해야 한다. 행 삭제 후 같은 키는 새 요청으로 취급된다.
프로세스가 비정상 종료되어 QUEUED/ANALYZING에 남으면 만료까지 409이며 자동 재실행하지 않는다.

Migration `20261019000000_analysis_idempotency`는 nullable VARCHAR(128) 컬럼과
복합 unique index만 추가한다. 기존 행은 NULL이므로 중복 없이 보존한다.
이전 migration은 수정하지 않는다. DB 적용은 하지 않았다.
배포 시 새 코드 실행 전에 migration이 필요하며, 큰 테이블의 index 생성 잠금은 배포 시 고려한다.

AI 오류의 공개 응답은 기존 ApiError 계약을 유지한다. 내부 failureKind로 TIMEOUT,
NETWORK, UPSTREAM, INVALID_RESPONSE를 구분한다. 내부 응답/토큰/스택을 응답이나 로그에 넣지 않는다.
실패 저장과 사용량 해제는 각각 시도하며, 이들의 실패는 일반화된 서버 로그만 남기고
최초 오류를 덮어쓰지 않는다. DB 장애 시 FAILED 저장 성공 자체를 보장하지는 못한다.
Usage는 여전히 TODO이며 실제 차감·해제는 수행하지 않는다.

타임아웃은 provider 호출에만 적용한다. Promise.race의 종료 후 늦은 provider 결과에는
DB 저장 경로가 없으며 DB 트랜잭션을 타이머 콜백에서 변경하지 않는다.
결과 DB 저장은 응답 수신·검증 뒤 수행하므로 타임아웃 콜백과 완료 저장을 경쟁시키지 않는다.
기본 30000ms는 유지한다. AI 순차 모델당 120초 가정 시 ALL에 241000ms 이상이 필요하며
실제 서버 실행 시간과 프록시 제한 확인 후 운영 설정을 정해야 한다.

GET /api/analysis/:analysisId는 현재 브랜치에 없다. #89에서는 UUID 검증, 소유권 검사,
미존재/만료 처리, DB 오류 COMMON500 변환, 오류 DTO/Swagger 및 조회 테스트가 필요하다.
기존 findWithModelResults를 재사용할 수 있으며 현재 변경에 GET API는 포함하지 않는다.

### PB-23 실제 PostgreSQL 검증 완료 (2026-10-19)

별도 로컬 테스트 DB에서 기존 4개 및 PB-23 migration을 deploy하고 Prisma diff가 없음을 확인했다.
단일/서로 다른 서버 프로세스의 동시 12요청 각각에서 분석 1행, 모델 결과 2행,
AI 실행 1회, Usage 예약 호출 1회였다. 동일 키 재사용/충돌/실패/만료 A~G 검증도 통과했다.
기존 DB에는 migration을 적용하지 않았고 #7 summary_jobs 테이블과 이력을 보존했다.
실제 Usage 차감은 TODO이며 호출 횟수만 검증했다.

준비된 격리 DB의 비공개 연결 상태 파일이 있으면 `node scripts/pb23/test.cjs`로
DB suite까지 포함한 `npm test -- --runInBand`를 실행한다. 일반 npm test에서는 DB suite가 opt-in이다.
자세한 비교표·SQL 근거·백업 위치는 `docs/PB-23-report.md`를 참조한다.
