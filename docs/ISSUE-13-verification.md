# Issue #13 TEXT Analysis 검증 결과

검증일: 2026-10-20. 결론: **핵심 요청·저장·IMAGE 회귀는 PASS, 입력 예외·Swagger 보완 필요**.

## 작업 상태

- 사용자 확인을 받아 `feature/#13-text-analysis`에서 진행했다. 요청에 적힌 `feat/`와 실제 `feature/` 차이를 확인한 뒤 작업했다.
- HEAD는 `49574f1` 그대로이며 시작 시 작업 트리는 깨끗했다.
- 브랜치 전환·merge·rebase·commit·push·PR 생성 없음.
- 운영 소스·기존 migration·.env 수정 없음. 검증 테스트와 본 보고서만 추가했다.

## 요구사항별 결과

| 요구사항 | 구현 위치 및 함수 | 검증 방법 | 결과 | 수정 필요 사항 |
|---|---|---|---|---|
| Analysis 도메인 재사용 | analysis.controller.ts create / analysis.service.ts createText | 실제 Nest HTTP→Service→Repository→PostgreSQL | PASS | 없음 |
| TEXT JSON 수신 | analysis.controller.ts create | application/json POST 202, multipart TEXT 400 | PASS | 없음 |
| IMAGE multipart 유지 | analysis.controller.ts create / AnalysisService.create | 기존 이미지 HTTP·Provider 회귀 전체 실행 | PASS | 없음 |
| IMAGE 응답 계약 유지 | AnalysisService.response | 기존 응답 키·형식 테스트 및 #12 대비 diff | PASS | 없음 |
| 공통 성공·오류 형식 | AnalysisService.createText / ApiErrorFilter.catch | ANALYSIS202 및 COMMON400의 isSuccess/code/message/result 검증 | PASS | 없음 |
| trim 및 필수 문자열 | analysis.dto.ts / normalizeTextInput | JSON HTTP 경계값 및 실제 DB 행 수 비교 | PASS | 없음 |
| 5~3,000자 | normalizeTextInput | 4/5/3,000/3,001, Unicode·공백 테스트 | PASS | 아래 DB 비호환 문자 예외 별도 |
| 검증 실패 시 저장 금지 | DTO / AnalysisService.createText | 요청 전후 analysis/model 테이블 count 비교 | PASS | 없음 |
| UUID / TEXT / QUEUED 저장 | AnalysisRepository.createText / schema.prisma | Prisma 기본 UUID와 DB 실제 행 조회 | PASS | 없음 |
| createdAt / updatedAt | AnalysisRepository.createText / @updatedAt | 생성 시 동일 시각, Prisma update 후 updatedAt 변경 | PASS | 직접 SQL 갱신에는 @updatedAt 미적용 |
| 30일 만료 | TEXT_RETENTION_MS / AnalysisRepository.createText | DB expiresAt-createdAt=2,592,000,000ms | PASS | 없음 |
| 미리보기 최대 200자 | AnalysisService.createText / textPreview | 실제 PostgreSQL과 Unicode 코드 포인트 길이 확인 | PASS | 마스킹 정책은 별도 결정 |
| 원문 필드 미보관 | AnalysisService.createText / Prisma 모델 | DB row·컬럼·모델 결과·응답에서 원문 suffix 부재 확인 | PASS | 짧은 입력은 미리보기=전체 내용임에 유의 |
| 관련 결과 테이블 원문 미저장 | AnalysisRepository.createText | 모델 결과 0건, 점수·근거·완료시각 NULL | PASS | 없음 |
| 애플리케이션 원문 로그 미출력 | TEXT Controller/Service/Repository | Logger log/warn/error/debug/verbose spy 및 소스 검토 | PASS | 인프라 로그 설정 전체 감사는 이번 범위 아님 |
| 기존 마스킹 정책 적용 여부 | src 전체 검색 / PROJECT_SCOPE.md | mask/마스킹/redact 검색과 저장 경로 검토 | PASS | 기존 TEXT 마스킹 정책·구현 없음. 새 마스킹은 추가하지 않음 |
| 만료·소유권 조회 제한 | AnalysisRepository.findActiveTextForUser | 실제 DB에서 만료 1ms 전 조회, 만료 시각·타사용자 null | PASS | GET API는 이 브랜치에 없음 |
| AI/Mock 결과·Usage 미실행 | AnalysisService.createText | 호출 spy 0회 및 QUEUED/결과 NULL 확인 | PASS | 없음 |
| IMAGE Idempotency-Key | AnalysisService.create / AnalysisRepository.claim | 실제 DB·단일/다중 프로세스 동시 12요청 | PASS | TEXT 키 지원은 없음, 전달 시 400 |
| Prisma migration | 20261020000000_text_analysis_input | 새 격리 DB에 baseline→신규 적용, 기존 행·diff 확인 | PASS | 실제 운영 배포 전 migration 필요 |
| Swagger 요청·오류 기재 | analysis.controller.ts ApiBody/ApiResponse | 생성된 OpenAPI에서 두 형식·길이·오류 설명 확인 | PASS | Content-Type별 스키마 분리는 아래 FAIL |
| Swagger Content-Type별 정확한 스키마 | analysis.controller.ts ApiConsumes/ApiBody | 두 media type 모두 동일 oneOf 노출 재현 | FAIL | JSON=TEXT, multipart=IMAGE 스키마를 각각 지정 |
| DB 비호환 문자열의 적절한 입력 오류 처리 | normalizeTextInput / AnalysisService.createText catch | NUL·단독 surrogate HTTP POST가 500으로 끝남을 재현 | FAIL | 저장 전에 공통 검증에서 거부하고 COMMON400 반환 |
| 실제 #96 AI 연동 | TextAnalysisProvider 포트 | 인터페이스만 존재, 실제 Provider 없음 | NOT TESTED | #96 후속 범위 |

파일은 별도 표시가 없으면 `src/domains/analysis/`에 있다.

## 입력 경계값

| 입력 | HTTP 결과 | 실제 DB 검증 |
|---|---|---|
| 4자 | 400 COMMON400 | 분석·모델 결과 행 수 불변 |
| 5자 | 202 ANALYSIS202 | UUID / TEXT / QUEUED |
| 3,000자 | 202 ANALYSIS202 | 미리보기 200자, 원문 suffix 없음 |
| 3,001자 | 400 COMMON400 | 행 수 불변 |
| 빈 문자열 / 공백만 | 400 COMMON400 | 행 수 불변 |
| number / null / object | 400 COMMON400 | 행 수 불변 |
| 누락 / array | 400 COMMON400 | 행 수 불변 |
| 앞뒤 공백 + 5자 | 202, trim된 미리보기 | 저장 전 trim 확인 |
| 앞뒤 공백 + 4자 | 400 COMMON400 | 행 수 불변 |

문자 수는 grapheme(화면상 글자)나 UTF-16 길이가 아닌 Unicode 코드 포인트 기준이다.
emoji·variation selector에 대한 기존 테스트도 통과했다.

## PostgreSQL 검증

- 테스트 DB: `localhost / pb23_test_1792489186783 / public`.
- 기존 테스트 접속의 localhost·pb23_test_* guard를 확인하고 새 별도 DB를 생성했다.
- 기존 개발 DB·운영 DB 및 기존 테스트 DB 데이터에는 migration을 적용하지 않았다.
- 선행 migration 5개를 적용하고 과거 createdAt의 IMAGE baseline 행을 생성한 뒤,
  #13 migration을 적용했다. baseline의 requestHash가 보존되고 textPreview=NULL,
  updatedAt=createdAt인 것을 확인했다.
- 현재 Prisma schema와 실제 DB의 migrate diff 결과: `No difference detected`.
- 실제 Service/Repository를 사용했고 DB transport는 Mock이 아니다.
- 외부 AI는 호출하지 않았으며 테스트 Provider와 Usage spy로 호출 부재를 검증했다.
- 만료 검증은 삭제나 실제 대기가 아니라 repository에 명시적인 조회 시각을 전달해 수행했다.
- 새 테스트 DB는 검토를 위해 남겼으며 DROP DATABASE/reset을 하지 않았다.

원문 미보관은 별도 원문 컬럼·로그·응답이 없다는 뜻이다.
미리보기는 첫 200자를 그대로 보관하므로 200자 이하의 입력은 전체 내용과 같고,
계좌번호·전화번호 등도 마스킹되지 않는다. 사용자가 승인한 현재 정책이며 후속 정책 결정이 필요하다.
원문의 SHA-256 requestHash도 저장되지만 이를 원문 재처리에 사용할 수는 없다.

## 발견한 문제와 재현

### 1. PostgreSQL 비호환 문자열이 500으로 반환됨

```json
{"type":"TEXT","text":"ab\u0000cd"}
{"type":"TEXT","text":"ab\ud800cd"}
```

두 입력 모두 현재 normalizeTextInput의 string/trim/코드 포인트 길이 검증을 통과하지만
Prisma/PostgreSQL 저장 단계에서 거부되고 createText의 catch가 COMMON500으로 바꾼다.
새 행은 저장되지 않고 내부 오류 메시지는 공개하지 않는다.

수정 방안: normalizeTextInput에서 NUL 및 well-formed Unicode 여부를 검사하여
저장 전에 COMMON400으로 거부한다. DTO와 직접 Service 호출이 같은 검증을 사용해야 한다.
재현 테스트는 현재 500 동작을 명시적으로 확인하는 characterization test이며,
요구사항이 해결됐다는 의미가 아니다. 수정 후 400 기대값으로 바꿔야 한다.

### 2. Swagger의 Content-Type별 스키마 혼재

`@ApiConsumes('multipart/form-data', 'application/json')`과 단일 ApiBody(oneOf) 때문에
JSON에도 IMAGE/file이, multipart에도 TEXT/text가 문서상 허용되는 것처럼 표시된다.
실제 HTTP 구현은 TEXT JSON을 구분하므로 실행 경로가 혼합되는 문제는 아니다.

수정 방안: OpenAPI requestBody.content의 application/json에는 TEXT schema,
multipart/form-data에는 IMAGE schema를 지정하도록 문서 생성을 보완한다.
현재 재현 테스트는 두 스키마가 동일함을 확인하며, 수정 후 달라야 한다는 검증으로 바꿔야 한다.

### 3. 기존 Mock 테스트의 환경 의존성

최초 전체 실행은 253 passed / 1 failed였다.
`test/mock-image-analysis.e2e-spec.ts`의 URL/토큰 누락 테스트가
ConfigService의 process.env fallback으로 로컬 AI 설정을 읽어 예외가 발생하지 않았다.
실제 AI 호출은 발생하지 않았다.

테스트 프로세스에서 AI_SERVICE_TOKEN/AI_SERVER_BASE_URL을 빈 값으로 격리한 후
254개가 모두 통과했다. .env와 운영 소스는 수정하지 않았다.
후속 수정 방안: 해당 테스트에서 환경 fallback을 비활성화하거나 환경변수를 저장·복원해
로컬 설정 유무와 무관하게 재현되도록 한다.

## 테스트 및 빌드 결과

- 새 실제 DB 검증 테스트: **18 passed**.
- 최종 전체 회귀: **254 passed, 10 suites passed, skipped 0**.
- 이 중 DB 비호환 입력 2개와 Swagger 혼재 1개는 현재 문제를 재현하는 진단 테스트다.
  테스트 전체가 통과했다고 해당 요구사항까지 모두 PASS인 것은 아니다.
- 기존 IMAGE 업로드·파일 검증·Provider·응답·오류·멱등성 회귀 통과.
- PostgreSQL 단일/다중 서버 12개 동시 요청 각각 분석 1행, 모델 결과 2행,
  AI 1회, Usage 예약 1회 확인.
- Prisma validate/generate, TypeScript typecheck, build, git diff --check 통과.
- 기존 dev의 sharp 전체 이미지 디코딩 보완은 이 브랜치에 미반영이다.
  현재 브랜치의 기존 MIME/확장자/시그니처 검증은 통과했고 기능을 추가하지 않았다.

## #96 연동 제약

- `TextAnalysisInput`: `{ analysisId, userId, text }`.
- `TextAnalysisProvider.analyze(input, signal: AbortSignal): Promise<unknown>`.
- 저장 이후 요청 메모리의 정규화 원문을 전달하는 지점이 필요하다.
- Provider 주입·결과 DTO·상태 전이·시간초과·Usage 정책은 #96에서 결정해야 한다.
- 원문을 저장하지 않으므로 현재 QUEUED 레코드만으로는 재처리할 수 없다.
  미리보기를 원문 대신 AI에 보내면 안 된다. 비동기 처리가 필요하면 별도 동의·보관·단기 전달 정책이 필요하다.

## 추가한 파일과 재현 방법

- `test/text-analysis-postgres.e2e-spec.ts`: TEXT 실제 DB 검증 및 문제 재현용 opt-in 테스트.
- `docs/ISSUE-13-verification.md`: 본 보고서.

검증용 임시 실행 도구: `/private/tmp/text13-verification.cjs`.
접속 상태는 `/private/tmp/text13-verify-Uxy76N/state.json`(0600)에 저장했으며 내용은 출력하지 않았다.
프로젝트 루트에서 아래 명령은 준비된 테스트 DB만 사용한다.

```bash
node /private/tmp/text13-verification.cjs --runTestsByPath test/text-analysis-postgres.e2e-spec.ts
node /private/tmp/text13-verification.cjs
```

이 도구는 TEXT13_DB_URL, PB23_DB_URL, DATABASE_URL을 격리 테스트 DB로 맞추고,
V1_DB_TEST=1 및 빈 AI 자격증명을 설정한 뒤 npm test -- --runInBand를 실행한다.
새 테스트의 baseline 검증은 앞서 설명한 사전 baseline 행을 전제로 한다.
임시 파일이 없어지면 새 격리 DB에 같은 migration/baseline 준비가 필요하다.
