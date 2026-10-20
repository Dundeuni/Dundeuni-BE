# Analysis API

현재 요청 유형은 `SCREEN`, `IMAGE`, `TEXT`이며 IMAGE만 구현되어 있습니다. `VIDEO`, `PHONE`, `QR`은 P1 이후 별도 이슈로 확장합니다.

AI 생성·변조 가능성과 사기 위험은 하나의 점수로 합치지 않고 별도 결과와 판단 근거를 반환합니다.

## POST /api/analysis — IMAGE

로그인 미구현으로 AccessTokenGuard를 임시 주석 처리했다. Authorization 헤더 없이 요청할 수 있다.
모든 요청은 임시 사용자 `development-user`로 저장한다. 로그인 구현 후 Guard와 인증 사용자 ID를 복원한다.

요청은 `multipart/form-data`이며 필드는 `type=IMAGE`, `file`이다.
DB `AnalysisType`은 IMAGE/TEXT/URL을 유지하며 SCREEN/TEXT 및 기존 URL 요청은 현재 400으로 거부한다.
SCREEN/TEXT 요청의 오류 메시지는 현재 IMAGE만 지원한다는 점을 명시한다.
JPEG(`image/jpeg`, `.jpg`/`.jpeg`)와 PNG(`image/png`, `.png`)만 허용한다.
MIME, 확장자, 파일 시그니처 및 크기를 확인한 후 sharp로 픽셀을 디코딩한다. 빈 파일과 손상되거나 읽을 수 없는 이미지는 400으로 거부하며 DB 저장·이용량 예약·Provider 호출 전에 검증한다.
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
이미지 분석은 동기 처리한다. Gemini 요약은 별도 DB 작업 큐/Worker로 비동기 처리하며, 분석 상세 GET은 아래 #89 계약을 따른다.

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
| 400  | COMMON400   | type/file 누락, 빈/손상 이미지, IMAGE 이외의 type, 잘못된 multipart |
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
- TEXT/URL 분석은 후속 구현. GET /api/analysis/{analysisId}는 아래 #89 계약을 따른다.

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
이 v1 구조 준비 단계에서는 GET 상세 조회를 추가하지 않았다. 이후 #89 구현은 아래 절을 따른다. 멱등성 키는 이전 제거 상태를 유지한다.
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
- `findWithModelResults(id)`: 기존 메타데이터/레거시 결과와 모델별 결과·요약 필드 조회. #89 GET API에서 재사용하며 기존 사용자 정책·소유권·만료를 확인한 뒤 공개 DTO로 변환한다.
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
- TruFor의 상세 결과는 DB 모델별 조회 메서드와 #89 GET 상세 조회 API로 확인한다.
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

## Gemini 비동기 요약 (Issue #7)

기존 POST 응답 형식과 상태 코드는 유지한다. CuRe/TruFor 결과를 저장한 뒤 요약 작업을 등록하고 반환한다. Gemini 호출은 HTTP 요청에서 수행하지 않는다. 전체 모델 실패의 기존 503 응답도 유지하지만, 저장된 실패 결과는 요약할 수 있다. 레거시 단일 모델 Provider 결과는 요약 대상에서 제외한다.

### GET `/api/analysis/{analysisId}/summary`

Body 없음. analysisId는 UUID. 현재 개발용 인증 생략 정책을 유지하며 `development-user` 기록만 조회한다. 인증 미들웨어/Guard가 적용되면 서버가 설정한 `request.user.id`로 조회한다. 인증 복원은 별도 작업이다.

```json
{
  "isSuccess": true,
  "code": "ANALYSIS200",
  "message": "이미지 분석 요약 조회에 성공했습니다.",
  "result": {
    "analysisId": "8c1b24c0-3186-4ee5-a679-74acb055b001",
    "summaryStatus": "COMPLETED",
    "summary": "AI 생성 여부는 판단하기 어렵습니다. 이미지 변조와 관련된 의심 신호가 감지되었습니다. 출처와 원본을 확인하는 것이 좋습니다.",
    "summaryModel": "configured-gemini-model",
    "summarizedAt": "2026-10-13T10:00:00.000Z"
  }
}
```

| 필드 | 타입 | Nullable | 설명 |
| --- | --- | --- | --- |
| result.analysisId | string(UUID) | F | 분석 ID |
| result.summaryStatus | string | T | PENDING / COMPLETED / FAILED. 비활성화·기존 데이터·등록 전에는 null |
| result.summary | string | T | 검증된 한국어 2~4문장, 최대 600자. 완료 외에는 null |
| result.summaryModel | string | T | 완료 시 사용한 설정 모델명 |
| result.summarizedAt | string(ISO 8601 UTC) | T | 완료 시각 |

200 ANALYSIS200: 상태 조회 성공(요약 실패도 조회는 성공). 400 COMMON400: UUID 오류. 404 COMMON404: 기록 없음/타인 기록/보관기간 만료. 500 COMMON500: 내부 오류. 오류는 기존 공통 envelope, result=null.

FE는 POST의 analysisId로 이 API를 폴링한다. PENDING이면 간격을 두고 다시 조회하고 COMPLETED/FAILED면 중단한다. null은 아직 등록되지 않았거나 요약 비활성화 상태이며 무한 폴링하지 않는다. 이미지 분석 결과와 요약 상태는 독립적이다.

### 설정 및 Worker 운영

1. 새 `20261014000000_analysis_summary_jobs` migration을 배포 절차에 따라 먼저 적용한다. 기존 migration은 수정하지 않는다.
2. 서버 환경에 GEMINI_API_KEY 및 GEMINI_MODEL을 설정한다. 키를 앱/로그/저장소에 노출하지 않는다.
3. GEMINI_SUMMARY_ENABLED=true로 켠다. 환경변수 누락 시 기본 비활성화이며 기존 `.env`는 자동 변경하지 않는다. enabled 상태에서 키/모델이 없으면 작업은 재시도 없이 FAILED가 된다.
4. Nest 앱과 함께 Worker가 실행된다. GEMINI_TIMEOUT_MS=15000, GEMINI_SUMMARY_POLL_MS=1000, GEMINI_SUMMARY_CONCURRENCY=1(프로세스당 최대 8), GEMINI_SUMMARY_MAX_ATTEMPTS=3(최대 10), GEMINI_SUMMARY_RETRY_MS=5000. 양의 정수 설정이며 재시도 간격은 지수 증가한다. SDK 자체 재시도는 끈다.

`analysis_summary_jobs`의 analysisId PK/FK로 중복 작업을 막는다. PENDING/RUNNING/COMPLETED/FAILED, attempts, nextRunAt, leaseUntil, leaseToken, lastErrorCode, 생성/수정 시각을 저장한다. 기존 summaryStatus는 공개 요약 상태이며 RUNNING 작업도 PENDING으로 보인다.

모델 결과 저장과 작업 등록은 **서로 다른 트랜잭션**이다. 등록 실패는 성공한 이미지 분석을 실패시키지 않으며 코드만 로그에 남긴다. Worker는 요약 미등록 완료/실패 모델 결과를 주기적으로 검색하여 등록 공백을 복구한다. 등록 시 summaryStatus=PENDING과 작업 생성은 한 트랜잭션이다. 이전 미요약 기록도 보관기간 내에서 자동 등록된다.

`FOR UPDATE SKIP LOCKED`로 원자적으로 선점한다. lease는 Gemini timeout+30초이며 재시작 시 만료된 RUNNING 작업을 다시 선점한다. leaseToken과 유효기간이 일치하는 Worker만 job 및 Analysis 요약을 같은 트랜잭션에서 저장한다. 이미 완료한 요약은 덮어쓰지 않는다. 5xx/네트워크/timeout은 제한적으로 재시도하고(429는 아래 별도 정책 적용) 설정/인증/형식/모순 오류는 즉시 실패한다. 종료 시 호출을 abort하고 작업을 재예약한다. 강제 종료나 DB 장애는 lease 복구로 처리한다. 여러 프로세스는 개별 동시성 제한을 가지며 전체 호출 수는 프로세스 수에 비례한다.

Gemini에는 DB 모델별 상태·판정·표시점수와 기존 calculateOverallResult 대표 판정만 전달한다. 이미지/경로/localization/rawScore/사용자·추적 ID/토큰과 자유서술 근거·제한사항은 입력에서 제외한다. 근거에 포함될 수 있는 내부 ID·토큰·API Key의 유출을 막기 위해 자유서술 텍스트를 전송하지 않는다. system instruction 및 JSON 출력 검증을 사용한다. 판정 echo, 문장 수·길이·한국어 및 명백한 판정 모순을 검사하지만 자연어 사실성이나 임의의 개인정보 패턴을 완전하게 보장하는 검사는 아니다. 공급자 근거에는 개인정보를 넣지 않는 계약이 필요하다.

요약 작업은 모델 결과·이미지 처리 상태를 변경하지 않는다. 요약은 기존 expiresAt을 따른다. 만료된 기록 조회는 404, 처리 전 만료 작업은 FAILED가 된다. 기존 자동 삭제 미구현 정책은 유지한다. Gemini 요청은 재시작/lease 만료로 중복 호출될 수 있지만 DB 완료 저장은 멱등적이다. abort는 외부 서비스 처리/과금 중단을 보장하지 않는다.

실제 Gemini 호출 검증은 키/모델을 별도 설정한 개발 환경에서 진행한다. 자동화 테스트는 Mock Client이며 실제 AI/Gemini 연동 검증과 구분한다.

### Gemini 장애 진단·재시도·관리자 복구 보완

호출 로그에는 실제 SDK 호출에 사용한 모델, timeoutMs, durationMs, HTTP status, 내부 오류 코드와 고정된 오류 메시지 분류(reason)를 기록한다. 공급자의 임의 오류 메시지는 개인정보·키·본문을 포함할 수 있어 출력하지 않는다. 알려진 메시지만 `model_overloaded`, `quota_or_rate_limit`, `model_unavailable`, `upstream_timeout`으로 분류하고 나머지는 `upstream_message_omitted`로 표시한다. 모델명도 허용된 Gemini 모델명 형식만 출력한다. 정상 호출도 소요 시간을 기록한다.

5xx(503/504 포함)·네트워크·timeout은 동일한 DB 작업을 재예약한다. 재시도 간격은 `min(RETRY_MAX_MS, RETRY_MS × 2^(attempts-1))`의 50~100% equal jitter이다. 기본 최대 간격은 GEMINI_SUMMARY_RETRY_MAX_MS=300000. attempts 상한·leaseToken fencing·선점 잠금은 유지하며 SDK 내부 재시도는 비활성화한다. 401/403 및 기타 영구 오류는 즉시 FAILED.

429는 `GEMINI_RATE_LIMIT`으로 구분한다. GEMINI_SUMMARY_RATE_LIMIT_POLICY=fail이 기본값이며 관리자에게 quota 확인을 맡긴다. 일시적 rate limit에 재시도가 필요하면 `retry`로 명시하고 GEMINI_SUMMARY_RATE_LIMIT_RETRY_MS=60000의 별도 cooldown+backoff+jitter를 사용한다. 동일 총 시도 횟수/최대 간격 상한을 적용한다. 이 정책은 quota를 늘리거나 우회하지 않으며 SDK Retry-After를 자동 적용하지 않는다.

**이미지·DB 없는 단독 테스트** (API 사용량 발생, 자동 재시도 없음):

```bash
npm run build
npm run gemini:smoke
```

현재 `.env`의 GEMINI_API_KEY/GEMINI_MODEL/GEMINI_TIMEOUT_MS로 고정된 공개 인사말만 보낸다. Nest/Worker/Prisma를 실행하지 않는다. 성공 여부·모델·소요시간·응답 글자 수 또는 안전한 오류 분류만 출력한다. 성공해도 실제 구조화된 요약 응답까지 검증한 것은 아니다. 키·사용자 데이터·응답 원문을 출력하지 않는다.

**관리자 실패 작업 복구** (서버/DB 접근 권한이 있는 운영자만 실행):

```bash
npm run build
npm run summary:recover -- <analysisId> --confirm
```

원인(모델·quota·서비스 가용성)을 확인한 뒤 대상 ID 하나만 명시한다. Worker를 시작하거나 Gemini를 직접 호출하지 않고 DB 작업을 PENDING으로 재등록한다. Worker 활성화 상태가 필요하다. job=FAILED 및 summaryStatus=FAILED, 모델 저장 완료, 미만료 기록만 허용한다. 기존 작업 행을 재사용하고 attempts=0, nextRunAt=현재로 초기화하며 lease·오류 코드를 지운다. job+Analysis 갱신은 단일 트랜잭션으로 처리한다. 동시 관리자 복구는 하나만 성공하고 RUNNING/PENDING/COMPLETED/만료/상태 불일치는 거부한다. 이전 Worker의 토큰은 완료 저장을 할 수 없다. CuRe/TruFor 및 POST 응답은 변경하지 않는다. 이전 실패 상세는 복구 전에 운영 로그로 확인한다(별도 영구 이력 테이블은 추가하지 않음).

이번 보완에는 Prisma 스키마 변경이나 추가 Migration이 없다.


이번 로컬 단독 호출 검증: 설정된 `gemini-3.8-flash`, timeout 30000ms로 공개 인사말 요청을 1회 수행하여 성공했다(약 19.6초, 응답 5자). 이는 단독 연결 확인이며 운영 안정성 또는 실제 모델 결과의 구조화된 요약 성공 검증은 아니다. HTTP timeout과 요약 검증 timeout은 같은 설정을 사용한다. 현재 `.env`는 보완 작업에서 변경하지 않았다.

DB 선점 SQL은 `CURRENT_TIMESTAMP AT TIME ZONE 'UTC'`로 TIMESTAMP(3) 예약/lease와 비교한다. 새 작업의 nextRunAt/createdAt도 명시적으로 UTC Date를 사용한다. PostgreSQL 세션이 Asia/Seoul인 환경에서 재시도 대기를 건너뛰거나 lease가 9시간 어긋나던 문제를 방지한다. 기존 데이터는 일괄 수정하지 않았으므로 이전 실패 작업은 관리자 복구 명령으로 재등록한다.

### 요약 판정 검증 진단

`SUMMARY_CONTRADICTION` 로그의 `diagnostic`에는 고정된 모델/조건 코드만 기록한다. 예: `generation:OPPOSITE_DECISION`, `manipulation:MISSING_SUSPICION`, `generation:MISSING_UNCERTAINTY`, `manipulation:MISSING_FAILURE`, `manipulation:MISSING_NOT_REQUESTED`, `generation:MISSING_MODEL_EXPLANATION`. 요약 원문·사용자 데이터는 출력하지 않는다. 기존 DB 오류 코드와 공개 API는 유지한다.

생성/인공지능/AI로/CuRe, 변조/조작/합성/TruFor 표현을 인식하고 관련 절 전체를 검사한다. 의심/가능성이 있음/징후·흔적 감지, 판단 어려움/불분명/판단할 수 없음, 신호·흔적 없음/발견되지 않음 등 동의어를 허용한다. FAILED는 실제 분석 실패 설명을, 미요청은 미분석 설명을 요구한다. 뒤 문장에서 판정을 뒤집거나 실패를 정상 결과로 서술하면 차단한다. 프롬프트는 두 모델을 주어가 명확한 별도 문장으로 설명하도록 요청한다. 규칙 기반 검증이므로 모든 자연어 표현을 이해하는 검증은 아니며, 허용되지 않은 표현은 원문 대신 diagnostic으로 확인해 회귀 테스트와 함께 보완한다.


## Issue #89 분석 결과 조회 및 비동기 요약 마무리

### GET `/api/analysis/{analysisId}`

analysisId는 path UUID다. 기존 개발용 인증 상태를 유지하며 요청 사용자 또는 임시 사용자
`development-user`의 보관 기한 내 결과만 조회한다.
200 ANALYSIS200, 잘못된 UUID는 400 COMMON400, 없는/다른 사용자/만료된 기록은 404 COMMON404,
DB 오류는 500 COMMON500으로 기존 공통 envelope를 사용한다.

```bash
curl http://localhost:3000/api/analysis/00000000-0000-4000-8000-000000000001
```

```json
{
  "isSuccess": true,
  "code": "ANALYSIS200",
  "message": "분석 결과 조회에 성공했습니다.",
  "result": {
    "analysisId": "00000000-0000-4000-8000-000000000001",
    "type": "IMAGE",
    "status": "COMPLETED",
    "aiGenerationScore": 80,
    "aiRiskLevel": null,
    "reasons": [{ "description": "[MOCK] CuRe 고정 가상 분석 근거" }],
    "modelVersion": "CuRe-mock-v0.2",
    "errorCode": null,
    "createdAt": "2026-10-15T00:00:00.000Z",
    "completedAt": "2026-10-15T00:00:01.000Z",
    "expiresAt": "2026-10-16T00:00:00.000Z",
    "models": {
      "status": "COMPLETED",
      "generation": {
        "status": "SUCCEEDED",
        "modelName": "CuRe",
        "modelVersion": "CuRe-mock-v0.2",
        "policyVersion": "mock-pilot-v0.2",
        "displayScore": 80,
        "decision": "AI_GENERATED_SUSPECTED",
        "reasons": [{ "description": "[MOCK] CuRe 고정 가상 분석 근거" }],
        "limitations": ["MOCK 응답이며 실제 AI 분석 결과가 아닙니다."],
        "errorCode": null,
        "retryable": null
      },
      "manipulation": null
    },
    "overallResult": {
      "decision": "GENERATION_OR_MANIPULATION_SUSPECTED",
      "decisionLabel": "생성·변조 의심",
      "policyVersion": "image-overall-v1",
      "suspectedKinds": ["generation"],
      "uncertainKinds": ["manipulation"]
    }
  }
}
```

예시는 CuRe만 저장된 결과다. 현재 공개 POST는 두 모델을 요청하며 TruFor도 같은 projection으로 반환한다.
기존 POST result의 모든 필드를 유지하고 기존 ImageModelsPublicResultDto를 models로 재사용한다.
overallResult는 기존 정책·enum으로 저장된 모델 판정에서 재계산하며 평균/합산 점수를 만들지 않는다.
레거시/모델 결과 미저장 분석은 models=null, overallResult는 INCONCLUSIVE다.
내부 DB 모델 ID·userId·requestHash·rawScore·localization은 공개하지 않는다.
진행 중 및 실패한 분석도 보관 기한 내에서 조회할 수 있다.
Prisma 스키마 및 migration 파일 변경이나 배포 DB migration 적용은 없다.

### 요약 처리 및 #98 역할 분리

분석 결과 트랜잭션 완료 → 요약 작업 및 summaryStatus=PENDING 별도 등록 → POST 202 반환.
Gemini 네트워크 호출은 Worker에서 실행하며 한국어 2~4문장과 판정 일치 검증 후
summaryStatus=COMPLETED, summary, summaryModel, summarizedAt을 저장한다.
영구 오류 또는 재시도 소진 시 FAILED와 null 요약 필드를 저장한다.
기존 503/504·네트워크·타임아웃 재시도, 횟수 상한·지연·jitter 환경변수 정책을 유지한다.
작업 PK와 원자적 claim, leaseToken fencing으로 중복 완료를 차단하고 서버 재시작 시 만료 lease를 회수한다.
Gemini 실패는 모델 결과·분석 상태·errorCode·completedAt을 변경하지 않는다.

분석 상세 GET에는 요약 데이터를 추가하지 않는다. 기존 `GET /api/analysis/{analysisId}/summary`는
삭제하지 않고 비동기 요약 상태 폴링 용도로 유지한다.
이 경로의 COMPLETED summary 응답은 #98의 요약본 상세 조회와 기능이 겹친다.
#98은 요약 기록 목록·요약본 상세·최근 3건 API, 페이지네이션/정렬/소유권 및 보관 정책을 정하고,
기존 /summary와의 호환·재사용·이관 방식을 확정해야 한다. 이번 작업에는 History API를 추가하지 않는다.

### 검증

- 새 상세 GET: 성공·모델별 결과·기존 필드·내부 데이터 비노출·UUID·404·DB 오류·진행/실패 상태·Swagger.
- 격리 PostgreSQL: POST→Prisma 저장→GET 결과 일치, 요약 PENDING→COMPLETED/FAILED,
  실제 Client 검증 경로를 통한 503 및 timeout, 요약 실패 후 분석 GET 응답 불변.
- 기존 테스트: 503/504 재시도와 소진·네트워크·중복 선점/완료·등록 복구·서버 재시작 lease 회수.
- Gemini 외부 통신은 테스트 대역으로 대체하며 실제 유료 서비스는 호출하지 않는다.


## Issue #97 위험도·근거·대응 안내 정규화

#89 GET 상세 조회·Gemini 비동기 요약을 유지한다. POST 필드와 상태 코드는 유지하고,
합의한 신규 필드 `GET result.guides: string[]`만 추가한다.
모델 이름은 기존 modelName(CuRe/TruFor)을 유지하며 model 별칭은 추가하지 않는다.
종합 판정의 기존 enum도 유지한다. FE에서 SUSPECTED는 아래 기존 의심 판정값을 의미한다.

| FE 의미 | overallResult.decision | 조건 |
| --- | --- | --- |
| SUSPECTED | GENERATION_OR_MANIPULATION_SUSPECTED | 성공 모델 중 하나라도 의심 |
| INCONCLUSIVE | INCONCLUSIVE | 의심 신호 없이 실패·미요청·판단 불가 모델 존재 |
| NO_CLEAR_SIGNAL | NO_CLEAR_SIGNAL | 두 모델 모두 성공하고 신호 없음 |

모델 점수를 평균·합산하지 않는다. overallResult는 생성·변조 신호의 종합 판정이며
aiRiskLevel은 기존 Provider의 별도 위험도 필드다. 위험 등급 정책 미확정 시 null을 유지한다.
AI 생성 가능성과 displayScore/aiGenerationScore는 사기 확률이 아니다.
null 점수는 0점이 아니며 null 위험도는 안전 판정이 아니다.

POST/GET 기존 reasons는 null을 유지하되, 배열이면 빈 항목과 중복을 제거한다.
GET 모델별 reasons/limitations는 없으면 []로 반환하고 공백을 정리한 뒤 중복을 제거한다.
같은 문구라도 다른 모델의 근거는 각 모델에 유지하며 한 모델의 점수·근거를 다른 모델에 합치지 않는다.
모델 실패 시 status/errorCode를 보존하고 decision/displayScore=null, reasons=[]로 표시한다.
limitations는 제공된 한계를 정리해 유지하며 빈 배열을 분석 한계가 없다는 뜻으로 표시하지 않는다.
원본 저장 데이터와 Provider 응답·내부 AI 판정 규칙은 변경하지 않는다.

### GET 표시용 응답 예시 (result 일부)

```json
{
  "aiRiskLevel": null,
  "overallResult": {
    "decision": "GENERATION_OR_MANIPULATION_SUSPECTED",
    "decisionLabel": "생성·변조 의심",
    "policyVersion": "image-overall-v1",
    "suspectedKinds": ["generation"],
    "uncertainKinds": []
  },
  "guides": [
    "사진이나 정보의 출처를 확인해 주세요.",
    "공유하기 전에 다른 자료와 비교해 주세요.",
    "관련 기관의 공식 홈페이지나 전화로 확인해 주세요."
  ]
}
```

INCONCLUSIVE 안내: “현재 분석만으로는 판단하기 어렵습니다.”,
“원본 사진이나 추가 자료를 확인해 주세요.”
NO_CLEAR_SIGNAL 안내: “뚜렷한 의심 신호는 발견되지 않았습니다.”,
“원본 사진이거나 안전한 정보라는 뜻은 아닙니다.”
실패 모델이 있으면 AI 생성/이미지 변조 분석 실패와 판단할 수 없다는 안내를 덧붙인다.
판단 근거와 대응 안내는 구분하며 만들어 낸 근거를 reasons에 넣지 않는다.

Gemini summaryStatus(PENDING/COMPLETED/FAILED)는 요약 작업 상태다.
모델 실행 status와 overallResult 및 guides와 독립적이며 요약 실패를 위험 판정으로 표시하지 않는다.
분석 상세에는 summaryStatus를 추가하지 않고 기존 /summary를 유지한다.

### FE 합의가 필요한 항목

- modelName과 기존 의심 enum을 그대로 사용한다. model 또는 SUSPECTED로 API 이름을 바꾸려면 별도 계약이 필요하다.
- aiRiskLevel 등급·색상·경고 수준 매핑은 미확정이다. 기존 값을 임의로 SAFE/CAUTION/DANGER로 변환하지 않는다.
- null 점수는 미제공, [] 근거는 추가 근거 없음으로 표시하며 안전을 의미하지 않는다.
- guides는 GET 전용 추가 필드다. POST 후 GET으로 상세·대응 안내를 받고 요약 상태는 /summary로 조회한다.
- 고령층 대상 문구의 최종 UX 검토와 표시 순서는 FE/기획에서 확인한다.
