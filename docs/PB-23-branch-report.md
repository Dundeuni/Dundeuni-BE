# #12 / PB-23 브랜치 분리 결과

2026-10-19. 현재 브랜치: `feature/#12-error-idempotency`.

## 결과

| 항목 | 결과 |
|---|---|
| #10 브랜치 보존 | PASS |
| #12 브랜치 생성 | PASS |
| #12 변경 사항 분리 | PASS — 새 브랜치의 미커밋 작업 트리로 유지 |
| #10 PR Diff 유지 | PASS — 로컬 #10 및 origin/#10 추적 ref 불변 |
| #12 PR Diff 독립성 | FAIL — 커밋 금지로 브랜치 간 커밋 diff는 아직 비어 있음 |
| 미커밋 변경 사항 보존 | PASS — 기존 변경 파일 21개 SHA-256 전부 일치 |

PR diff의 FAIL은 구현 실패가 아니라 **미커밋으로 인해 PR에 표시할 커밋이 아직 없음**을 뜻한다.
요청한 안전한 로컬 브랜치 생성과 변경 보존은 완료했다. PR diff 완성에는 이후 별도 승인된 커밋이 필요하다.
이번 작업은 커밋·stage·push·PR 생성이나 기존 PR 수정 없이 끝냈다.

## HEAD와 의존성

- #10 HEAD: `317791a7bf4034321df7f1310caa3e90ea25b9b8`
- #12 HEAD: `317791a7bf4034321df7f1310caa3e90ea25b9b8`
- 시작 브랜치와 원격 추적 origin/#10은 같은 HEAD였다. #12 변경은 전부 미커밋이었다.
- #10이 #6 끝점 `049dc09` 위에 포함한 커밋은 `5117ea6`, `317791a` 두 개다.
- 실제 조상 관계는 main `115e6b0` → #6 `049dc09` → #10 `317791a` → #12 작업 트리다.
- #7은 `a20369f`에서 갈라진 별도 브랜치이며 #12의 선행 의존성이 아니다.
- 권장 PR Base: `feature/#10-ai-integration`, Compare: `feature/#12-error-idempotency`.
  #10 미병합 상태에서 main을 Base로 사용하면 #6/#10 변경까지 함께 보인다.
- #10의 현재 HEAD가 #12 이전 기준이다. reset/rebase/cherry-pick은 필요하지 않았다.

## 보존과 diff 검증

변경 파일 원본, binary diff, 파일별 SHA-256, 시작 Git ref 목록을
`/private/tmp/pb23-branch-odozllew`에 백업했다. 기존 DB 백업과는 별개다.
원본 21개 파일은 해시 일치, 기존 모든 ref는 변경 없음, 새 ref는 #12 하나뿐이었다.
같은 파일의 #10 코드는 커밋에 보존되어 있고 #12 변경 hunk만 작업 트리에 남았다.

- `git log feature/#10-ai-integration..feature/#12-error-idempotency`: 비어 있음.
- `git diff feature/#10-ai-integration...feature/#12-error-idempotency`: 비어 있음.
- `git diff feature/#10-ai-integration`: 추적된 #12 변경 hunk만 표시.
- 신규 #12 파일은 `git ls-files --others --exclude-standard`로 별도 확인.
- #10 커밋의 ls-tree에 #12 migration, error 클래스, 전용 테스트/스크립트/보고서 없음.
- origin ref는 로컬에 저장된 원격 추적 상태를 기준으로 확인했다.
  원격 fetch나 GitHub PR API 조회는 하지 않았으며 실제 PR Base/메타데이터는 조회하지 않았다.
- 미커밋 파일은 Git 브랜치 객체에 저장되지 않는다. 새 브랜치에서 작업을 이어가야 하며,
  커밋 전 단순 브랜치 전환 시 변경이 따라갈 수 있다. 백업은 이 상태를 보호하기 위해 남겼다.

## #12에 유지한 파일

기존 변경 파일 21개:

- src/domains/analysis/analysis.controller.ts
- src/domains/analysis/analysis.service.ts
- src/domains/analysis/analysis.repository.ts
- src/domains/analysis/image-analysis.service.ts
- src/domains/analysis/http-image-analysis.provider.ts
- src/domains/analysis/image-analysis.error.ts
- prisma/schema.prisma
- prisma/migrations/20261019000000_analysis_idempotency/migration.sql
- test/analysis.e2e-spec.ts
- test/http-image-analysis.e2e-spec.ts
- test/analysis-idempotency.e2e-spec.ts
- test/image-analysis-v1-db.e2e-spec.ts
- test/pb23-postgres.e2e-spec.ts
- scripts/pb23/audit.cjs
- scripts/pb23/prepare.cjs
- scripts/pb23/migrate.cjs
- scripts/pb23/server.cjs
- scripts/pb23/test.cjs
- scripts/pb23/verify.cjs
- docs/api/analysis.md
- docs/PB-23-report.md

이번 작업에서 본 보고서 `docs/PB-23-branch-report.md`만 추가했다.
기존 요청에 열거되지 않은 DB 통합 테스트/스크립트도 이전 PB-23 작업의 일부이므로 보존했다.

## #10에 보존한 파일과 기능

#10 커밋 트리 전체를 수정하지 않았다. 대표 파일은 다음과 같다.

- http-image-analysis.provider.ts: 인증, multipart 전송, HTTP/JSON 처리 원본 구현.
- mock-image-analysis.provider.ts 및 analysis.module.ts: Mock/HTTP 전환 구조.
- image-analysis.service.ts 및 v1 DTO/validator: AI v0.2 정규화 원본 구현.
- analysis.repository.ts 및 schema.prisma: 기존 분석/모델별 저장 구조.
- test/http-image-analysis.e2e-spec.ts, test/image-analysis-v1-db.e2e-spec.ts 및 기존 회귀 테스트.
- docs/api/analysis.md: 기존 #10 API 명세.
- 기존 migration 4개. PB-23 migration은 #10 커밋에 없다.

이 파일들은 #12에서도 상속하며 해당 파일 전체를 옮기거나 #10 코드를 삭제하지 않았다.

## 브랜치별 검증

| 검증 | #10 HEAD 임시 추출본 | #12 작업 트리 |
|---|---|---|
| Prisma validate | PASS | PASS |
| Prisma generate | PASS | PASS |
| TypeScript | PASS | PASS |
| build | PASS | PASS |
| npm test -- --runInBand | 171 passed / 28 skipped | 180 passed / 35 skipped |
| diff 공백 검사 | 커밋 원본 유지, diff 없음 | PASS |

#10은 git archive로 임시 디렉터리에 추출하여 검사했다. 실제 브랜치를 되돌리지 않았다.
#10 검사 후 #12 스키마로 Prisma Client를 다시 생성했다.
이번에는 V1_DB_TEST=0, PB23_DB_URL 비활성화 및 접속 불가능한 검증용 DB URL로
DB 테스트와 migration을 실행하지 않았다. HTTP는 로컬 Mock만 사용했다.
#12의 제외 35개는 기존 DB 테스트 28개와 새 PB-23 PostgreSQL 테스트 7개다.
이전 작업에서 실제 DB 포함 215 passed 결과는 이미 docs/PB-23-report.md에 기록되어 있다.
사용자 요청의 “DB 검증 미완료” 설명은 그 이전 시점이며 이번 턴에 DB 검증을 재실행하지 않았다.

## 남은 작업

별도 승인 후 #12 변경만 커밋하면 Base=#10 / Compare=#12의 PR diff를 검증할 수 있다.
현재는 push/PR 생성 전 단계다. 커밋 없이는 작업 트리 변경을 GitHub PR diff에 표시할 수 없다.
기존 #6/#7/#10 이력 또는 원격 브랜치를 수정할 필요는 없다.
