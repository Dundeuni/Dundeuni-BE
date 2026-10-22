# Issue #15 / #17 분리 완료 보고

> 아래 본문은 미커밋 분리 작업 당시의 검증 기록이다. 이후 사용자가 두 브랜치의 커밋·푸시를 명시적으로 요청했다. 반영 순서는 #15 POST/OCR 커밋 → #17 기준을 #15로 fast-forward → #17 GET/정규화 전용 커밋이다. 강제 푸시 및 이력 재작성은 하지 않는다.

## 시작 상태와 보존

시작 브랜치는 feature/#17-analysis-response-normalization, HEAD는 #15의 0466c9c1c72b9cdcdc1172d6f629516d2d15e469였다. 수정 파일 15개와 신규 파일 6개가 미커밋이었다. dev/main 및 다른 브랜치 커밋은 변경하지 않았다.

원본 21개 파일과 Git binary patch, 상태, SHA-256 manifest를 아래 위치에 보존하고 압축 파일에서 각 원본 해시 일치를 확인했다.

`/var/folders/5h/m63kdpc960j15lf882h0nml00000gn/T/dundeuni-15-17-backup-ajjh2nr5`

원본 복구가 필요하면 해당 파일 백업을 별도 임시 폴더에 먼저 풀어 비교한다. 작업 후 변경 위에 패치를 무조건 덮어쓰지 않는다. stash/reset/clean/강제 checkout은 사용하지 않았다.

## 최종 작업 위치

- #15: `/Users/nohnamgyeong/Desktop/Dundeuni-BE/.worktrees/issue15-ocr-public`, 브랜치 feature/#15-text-ai-integration
- #17: `/Users/nohnamgyeong/Desktop/Dundeuni-BE`, 브랜치 feature/#17-analysis-response-normalization

Commit 금지 조건으로 두 브랜치의 HEAD는 모두 기존 0466c9c를 유지한다. 실제 merge/commit/push/PR을 하지 않았다. #15 작업 트리에는 POST 구현만 있고, #17 작업 트리에는 동일한 POST 기반과 GET 전용 추가분이 있다. 따라서 현재 `git diff HEAD`에서 #17에 #15 변경이 함께 보이는 것은 정상이다. Git 이력상 분리는 아직 완료되지 않았으며, 별도 패치로 #15 기반과 #17 전용 차이를 분리했다.

## #15에 배치한 구현과 파일

- `analysis.dto.ts`: 공개 sourceType=DIRECT/SCREEN_CROP 검증
- `analysis.controller.ts`: 명시적인 type/sourceType 분기, POST Swagger와 헤더 입력 정리. GET 없음
- `analysis.swagger.ts`, `main.ts`: JSON과 multipart를 분리한 Swagger 요청 스키마
- `analysis.module.ts`: type/sourceType/file 수용 및 공통 Guard 등록
- `analysis.service.ts`: 기존 IMAGE 검증을 캡처와 공유하고 캡처 Workflow 연결. 상세 조회 없음
- `text-ai-workflow.service.ts`, `text-analysis.input.ts`: 기존 TEXT/AI 결과 검증·저장 흐름에서 OCR Provider 재사용
- `analysis.repository.ts`: 캡처 생성/멱등성 claim에서 출처 메타데이터 저장. 인증 상세 조회 메서드 없음
- `src/common/auth/request-user.guard.ts`: 개발 사용자/운영 JWT 공통 정책
- `test/text-capture.e2e-spec.ts`: 공개 POST 계약·OCR·실패·타임아웃·멱등성 검사. GET 의존 없음
- `test/text-ai-postgres.e2e-spec.ts`: 실제 PostgreSQL에서 DIRECT와 OCR 결과 및 실패 출처 저장
- 기존 IMAGE/TEXT/DB 테스트와 `scripts/pb23/server.cjs`: 개발 인증 환경 명시 및 새 Swagger 계약 반영
- `README.md`, `docs/api/analysis.md`, `docs/AI-TEXT-INTEGRATION-E2E.md`, `docs/API-POST-TEXT-OCR.md`: POST 문서

기존 URL/token 누락 검증 테스트는 `.env` 유무에 의존하지 않도록 빈 값을 명시했다. 기존 DB Swagger 테스트는 수정 전 결함(oneOf 스키마 공유) 재현 대신 JSON/multipart의 분리 계약과 필수 필드를 검증하도록 갱신했다. 기존 migration 검증의 역사적 baseline 행 단언은 유지했고, 격리 DB 준비 단계에서 TEXT migration 전 실제 행을 삽입했다.

## #17 고유 추가분

- `analysis.controller.ts`: 상세 GET 신규 구현·Swagger
- `analysis.service.ts`: findOne과 조회 오류 변환
- `analysis.repository.ts`: id/userId/expiresAt 조건의 findActiveWithModelResults
- `analysis-result.mapper.ts`: 공통 결과 DTO와 저장 결과 매핑
- `test/analysis-response-normalization.e2e-spec.ts`: 매핑, 상태, 출처, Guard·권한·만료·Swagger
- `test/analysis-query-postgres.e2e-spec.ts`: 실제 PostgreSQL의 공개 DIRECT/캡처 POST→저장→GET 및 출처·접근 검사
- `README.md`, `docs/api/analysis.md`의 GET 문서 연결, `docs/ANALYSIS-RESPONSE-NORMALIZATION.md`, 본 분리 보고서

공통 POST 코드·Guard·테스트는 #15와 동일하고, #17 전용 패치에 OCR 요청 구현은 중복 포함하지 않는다.

## 최종 공개 API

| 입력 | 요청 | 내부 처리 |
| --- | --- | --- |
| 일반 이미지 | multipart type=IMAGE, file. sourceType 금지 | CuRe/TruFor `/internal/v1/image-analyses`, models=ALL |
| 직접 TEXT | JSON type=TEXT, sourceType=DIRECT 또는 생략, text | 공개 DIRECT → 내부 TEXT, `/internal/v1/text-analyses` |
| 문자 캡처 | multipart type=TEXT, sourceType=SCREEN_CROP, file | 내부 SCREEN_CROP, `/internal/v1/text-analyses/image` |

sourceType 생략의 DIRECT 호환은 기존 #13/#15 JSON 요청을 유지하기 위한 정책이다. 캡처는 명시적인 SCREEN_CROP 없이 전송할 수 없다. 파일 내용 자동 분류는 하지 않는다. IMAGE 요청은 TEXT 전용 출처를 거부한다.

OCR 엔드포인트가 피싱 분석 결과까지 반환하는 계약이며 BE에서 TEXT AI를 재호출하지 않는다. Analysis.type=TEXT로 저장한다. 진행·실패 캡처는 기존 textResult JSON의 sourceType 메타데이터로 구분한다. 완료 시 검증된 결과로 교체한다. GET 직접 TEXT 출처는 기존 TEXT 표현을 유지하며 요청의 DIRECT와 구분한다.

## DB·인증·보관

Prisma Schema/migration 변경 없음. 기존 TEXT 입력 preview 200자 정책 외에 원문을 새로 저장하지 않는다. 캡처 preview는 빈 값이며 OCR 본문·이미지·자유문구 근거는 영구 저장하지 않는다. TEXT/캡처 30일 만료 정책과 IMAGE 모델별 결과 저장을 유지한다.

공통 Guard는 #15에 배치하고 #17에서 재사용한다. development만 development-user, 나머지는 JWT sub다. production 프로세스에서 개발 우회는 불가능하다. GET 소유권·만료 조건을 유지한다.

## 최종 검증

격리 PostgreSQL DB를 브랜치별로 새로 생성하고 기존 migration을 순서대로 적용했다. #13 역사 데이터 검증을 위해 TEXT migration 전에 baseline 행을 넣었다. 기존 개발 DB에는 migration이나 데이터 변경을 하지 않았고 작업 전용 DB는 테스트 후 삭제했다.

| 작업 트리 | 결과 | skip |
| --- | --- | --- |
| #15 | 13개 suite, 324개 테스트 통과 | 실제 AI live 1개 |
| #17 | 15개 suite, 367개 테스트 통과 | 실제 AI live 1개 |

실제 PostgreSQL·Prisma·HTTP Controller를 사용한 POST→DB와 #17 POST→DB→GET 검증을 포함한다. AI HTTP 전송은 Mock이므로 실제 OCR 및 피싱 모델 실추론은 검증하지 않았다. IMAGE DB 트랜잭션/모델별 저장, TEXT 요청 보관, 멱등성 동시성 회귀 테스트도 통과했다.

실행은 작업 전용 DB URL을 DATABASE_URL/PB23_DB_URL/TEXT13_DB_URL/TEXT_AI_DB_URL에 주입하고 V1_DB_TEST=1, TEXT_AI_PROVIDER=disabled로 전체 Jest를 실행했다. HTTP 모드 테스트는 자체 http 설정으로 검증한다. 일반 테스트의 disabled/QUEUED 전제를 `.env`와 분리했으며 토큰을 출력하지 않았다. 타입 검사·빌드·diff 공백 검사도 두 작업 트리에서 수행했다.

## 남은 작업과 권장 PR 관계

실제 AI 인증/통신 및 OCR→피싱 실추론 재검증, 위험 단계·Safety 안내 정책, Gemini 실제 생성, 로그인/토큰 발급은 남아 있다. 기존 공통 Mapper는 임의 위험 단계 없이 UNKNOWN과 guidance=[]를 유지한다.

원격 #15는 0466c9c와 일치하고 원격 #17 브랜치는 확인되지 않았다. GitHub PR API는 접근되지 않아 기존 열린 PR의 base/compare는 확인하지 못했다. 권장 관계는 #15 PR의 compare=feature/#15-text-ai-integration, base=dev(선행 #10/#13 중복 범위 확인), #17 PR의 compare=feature/#17-analysis-response-normalization, base=feature/#15-text-ai-integration이다.

사용자가 Commit을 승인한 이후 #15를 먼저 커밋하고, #17에서 공통 변경의 중복 적용을 피하며 #15 커밋을 반영한 다음 #17 전용 패치만 커밋해야 Git 이력상 분리가 완성된다. 현재는 안전한 작업 트리·패치 분리까지만 완료했다.

## 분리 패치와 적용 검증

패치 위치: `/private/tmp/dundeuni-issue15-17-split-au9d94kj`

- `issue15-from-base.patch`: 기존 0466c9c 위에 #15 POST/OCR 보완을 적용하는 전체 패치
- `issue17-on-issue15.patch`: #15 작업 트리 위에 GET/정규화만 추가하는 패치
- `issue17-full-snapshot.patch`: 원래 HEAD 위에 현재 #17 전체 작업 상태를 복원하는 패치
- `manifest.json`: 브랜치별 변경 파일 목록과 tree 식별자

별도 임시 Git 인덱스에 #15 패치와 #17 전용 패치를 순서대로 적용한 결과가 #17 전체 패치를 적용한 tree와 일치하는지 검사한다. 원본 저장소 인덱스나 커밋은 수정하지 않는다.
