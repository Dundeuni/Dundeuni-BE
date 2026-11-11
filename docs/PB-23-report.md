# PB-23 결과 보고

최종 판정: **PASS — 현재 브랜치의 PB-23 범위 및 실제 PostgreSQL 멱등성 검증** (2026-10-19)

실제 Usage 과금 연동, 운영 AI 타임아웃 결정, #89 GET 조회는 별도 후속 범위다.
이전 보고서의 PostgreSQL 미검증에 따른 CONDITIONAL은 이번 통합 검증으로 해소했다.

## 환경과 보호 범위

- 브랜치: `feature/#10-ai-integration`, HEAD `317791a7bf4034321df7f1310caa3e90ea25b9b8` 유지.
- 이전 PB-23 미커밋 변경을 보존했다. 기존 migration SQL, #6 Mock Provider, #7 Worker 수정 없음.
- Prisma 6.19.3, PostgreSQL 18.6.
- 기존 DB: localhost:5432 / dundeuni / public, `.env`의 NODE_ENV=development 확인.
- 테스트 DB: 같은 로컬 서버의 **별도 데이터베이스** `pb23_test_1792378384606` / public.
  기존 DB와 테이블·migration 이력이 분리된다. 데이터베이스 서버 자원은 공유한다.
- 기존 DB에는 읽기 전용 점검과 pg_dump만 실행했다. migration/데이터 변경 없음.
- 실제 AI 서버 호출, commit/push/PR 생성, reset, DROP DATABASE 실행 없음.

## Migration 검증

| 항목 | 결과 | 근거 |
|---|---|---|
| 기존 DB 백업 | PASS | PostgreSQL 18 pg_dump custom archive 생성, pg_restore --list 성공 |
| 기존 DB Migration 이력 | PASS | 5개 적용 완료, 실패/rollback 없음, 해당 브랜치 SQL checksum 일치 |
| #7 Migration 차이 확인 | PASS | 아래 비교표 및 읽기 전용 migrate diff |
| 격리된 PostgreSQL 준비 | PASS | 별도 pb23_test DB, 접속 대상 이름 검증 guard 적용 |
| PB-23 Migration 적용 | PASS | 테스트 DB _prisma_migrations 적용 완료 및 checksum 일치 |
| UNIQUE 제약 확인 | PASS | pg_indexes 직접 조회 및 다중 프로세스 경합 성공 |

백업 위치: `/private/tmp/pb23-3PECpp/existing.dump`.
디렉터리 권한 0700, 백업 및 접속 상태 파일 0600. 백업 내용은 출력하지 않았고 Git에 추가하지 않았다.
초기 기본 pg_dump 17은 서버 18과 버전 불일치로 실패하여 설치된 `/Library/PostgreSQL/18/bin/pg_dump`로 재실행했다.
아카이브 목록 검증은 수행했으며 복원 검증은 수행하지 않았다.
임시 경로이므로 장기 보관용 백업은 아니다. 테스트 DB와 백업은 검토를 위해 남겼다.

### 브랜치와 기존 DB 비교

| Migration | #7 브랜치 | #10 작업 트리 | 기존 DB | 격리 테스트 DB |
|---|---|---|---|---|
| 20261004000000_create_analysis | 있음 | 있음 | 적용 | 적용 |
| 20261008000000_remove_analysis_idempotency_key | 있음 | 있음 | 적용 | 적용 |
| 20261012000000_image_analysis_v1 | 있음 | 있음 | 적용 | 적용 |
| 20261013000000_nullable_failed_model_decision | 있음 | 있음 | 적용 | 적용 |
| 20261014000000_analysis_summary_jobs | 있음 | 없음 | 적용 | 미적용 |
| 20261019000000_analysis_idempotency | 없음 | 신규 미커밋 | 미적용 | 적용 |

공통 4개 migration의 checksum은 양쪽 브랜치와 기존 DB에서 일치한다.
summary_jobs checksum은 #7 SQL과 기존 DB에서 일치한다.
테스트 DB의 적용된 5개 checksum은 현재 작업 트리와 모두 일치한다.
기존 DB 적용 순서는 표의 첫 5개 순서다. #7/#10 비교는 git show/ls-tree/diff로만 수행했다.

#7의 SQL은 SummaryJobStatus enum, analysis_summary_jobs 테이블, analysisId PK/FK,
(status,nextRunAt) 인덱스를 추가한다. PB-23은 analysis_requests에 nullable
VARCHAR(128) idempotencyKey 및 UNIQUE(userId,idempotencyKey)를 추가한다.
둘 다 기존 analysis_requests에 의존하지만 서로의 테이블/컬럼에는 의존하지 않는다.

기존 DB→현재 Prisma의 읽기 전용 diff는 #7 전용 FK/테이블/enum 제거와 멱등성 컬럼/인덱스 추가를 제안했다.
**이 diff SQL은 실행하지 않았다.** 기존 summary_jobs와 migration 이력은 그대로 유지한다.
#7 모델과 현재 모델의 차이에 따른 예상 불일치이며 기존 DB를 현재 브랜치 스키마로 덮어쓰면 안 된다.

테스트 DB에는 기존 4개 migration을 먼저 deploy하고 테스트용 baseline 행을 넣은 뒤 PB-23을 deploy했다.
baseline 행의 id/requestHash를 유지하고 idempotencyKey=NULL인 것을 확인했다.
Prisma migrate diff --exit-code 결과는 `No difference detected`였다.
기존 모델별 UNIQUE(analysisId,kind), analysisId FK와 모든 PK도 유지됐다.

## 실제 PostgreSQL 멱등성 테스트

각 테스트는 HTTP 요청, 실제 AnalysisRepository/Prisma, MockImageAnalysisProvider를 사용한다.
서버별 AI/Usage 카운터는 IPC로 수집한다. 아래 횟수는 해당 시나리오 전체의 합계다.
서버는 테스트 전용으로 구성하며 외부 AI 자격증명이나 호출을 사용하지 않는다.
현재 컨트롤러의 임시 development-user는 격리 DB 안에서만 테스트 사용자로 사용한다.

| 테스트 | 결과 | DB 분석 행 수 | AI 실행 횟수 | Usage 예약 |
|---|---|---|---|---|
| A 최초 요청 | PASS | 1 | 1 | 1 |
| B 동일 키 + 동일 내용 | PASS | A의 1건 유지 | 추가 0 | 추가 0 |
| C 동일 키 + 다른 내용 | PASS, 409 | A의 1건 유지 | 추가 0 | 추가 0 |
| D 다른 키 + 동일 이미지 | PASS | 키마다 1건, 합계 2 | 추가 1 | 추가 1 |
| E 단일 서버 동시 12요청 | PASS | 1 | 1 | 1 |
| E 서로 다른 서버 프로세스 동시 12요청 | PASS | 1 | 1 | 1 |
| F 실패 요청 재전송 | PASS, 503 재사용 | FAILED 1건 | 합계 1 | 합계 1 |
| G 만료된 키 | PASS, 409 | 기존 1건 유지 | 추가 0 | 추가 0 |

두 동시성 테스트 모두 202 1개, 409 11개였다. 실제 DB unique insert 경합에서
P2002 처리 경로를 통해 11개 요청이 기존 행을 조회했다. AI/Usage는 선점 성공자만 실행했다.
각 완료 분석에는 CuRe/TruFor 결과 2건이 있었고 모델별 중복은 없었다.
실패 분석은 모델 결과 없이 FAILED/ANALYSIS503을 저장하고 Usage 해제 호출은 1회였다.
완료 응답은 다른 서버 프로세스에서도 최초 202 JSON과 정확히 같았다.
내용 충돌/만료 재전송 전후 분석 행 전체가 같음을 검증했다.
만료 재현용 expiresAt 수정은 테스트 DB에만 수행했다.

### SQL 조회 근거

테스트는 다음 쿼리로 각 키의 실제 행과 모델 결과 수를 확인한다.

```sql
SELECT a.id, a.status,
  (SELECT count(*)::int FROM analysis_model_results m
   WHERE m."analysisId" = a.id) AS "modelCount"
FROM analysis_requests a
WHERE a."userId" = $1 AND a."idempotencyKey" = $2;
```

두 동시성 시나리오 모두 결과는 분석 1행, COMPLETED, modelCount=2였다.
GROUP BY userId,idempotencyKey HAVING count(*)>1 및
GROUP BY analysisId,kind HAVING count(*)>1의 중복 그룹 수는 각각 **0**이었다.
각 실행은 UUID 기반 다른 키를 사용하므로 반복 실행한 테스트 행은 별도로 남는다.
기존 DB는 검증 전후 분석 15건/모델 결과 28건, migration 5개로 변함없었다.

## 전체 회귀 검증

- `node scripts/pb23/test.cjs`: 내부에서 **npm test -- --runInBand** 실행.
- 기존 DB 테스트 28개와 새 PostgreSQL HTTP 테스트 7개 포함 **215 passed, 8 suites passed, skipped 0**.
- `npx prisma validate`, `npx prisma generate`, `npm run typecheck`, `npm run build`, `git diff --check` 통과.
- 기존 DB 테스트도 PB23_DB_URL을 우선 사용하도록 최소 수정하여 격리 DB의 별도 임시 schema에서 수행했다.
  이 테스트의 정리는 해당 격리 DB의 테스트 schema에만 적용되며 기존 DB에는 접근하지 않는다.
- 일반 npm test에서는 opt-in DB suite가 제외된다. 전체 DB 포함 재현은 위 runner를 사용한다.

## 기존 구현과 이전 보완

기존 HTTP 오류/JSON/v0.2 계약 검증, 부분 모델 실패 보존, 전체 실패 저장,
AbortController/AbortSignal/deadlineAt, 원본 버퍼 정리와 민감 원문 미저장 로직을 재사용했다.
이전 PB-23 작업에서 최초 오류 보존, 내부 실패 종류 분류, 늦은 응답 무시 회귀 테스트,
사용자별 키 선점·완료/실패 응답 재사용·처리 중 409·만료/내용 충돌 정책과 Swagger를 추가했다.
이번 DB 검증에서 프로덕션 코드 수정은 필요하지 않았다.

## 이번 작업 변경 파일

- `scripts/pb23/audit.cjs`: 기존 DB 읽기 전용 이력/checksum/상태 확인.
- `scripts/pb23/prepare.cjs`: 개발 DB guard, 제한 권한 백업, 별도 테스트 DB 생성.
- `scripts/pb23/migrate.cjs`: 기존 DB 읽기 전용 diff, 새 테스트 DB migration 단계 적용/제약 확인.
- `scripts/pb23/server.cjs`: 별도 서버 프로세스 및 제어 가능한 Mock Provider/Usage 계측.
- `scripts/pb23/test.cjs`: 비공개 로컬 상태 파일에서 테스트 연결을 읽어 전체 Jest 실행.
- `scripts/pb23/verify.cjs`: 백업 archive, 테스트 migration checksum/중복 조회 확인.
- `test/pb23-postgres.e2e-spec.ts`: A~G 실제 DB/HTTP/다중 프로세스 테스트.
- `test/image-analysis-v1-db.e2e-spec.ts`: PB23 격리 DB 연결 선택 및 이름 guard.
- `docs/PB-23-report.md`, `docs/api/analysis.md`: 검증 근거와 실행 방법.

prepare/migrate는 **새 격리 DB 준비 단계에서 한 번씩** 실행한다.
접속 정보는 Git 밖의 `/private/tmp/pb23-3PECpp/state.json`(0600)에 있고 내용을 출력하지 않는다.
테스트 runner는 `/private/tmp/pb23-state-path` 포인터를 사용한다.
백업 또는 테스트 DB를 생성하는 prepare를 회귀 테스트 목적으로 반복할 필요는 없다.

이전 PB-23 미커밋 파일은 그대로 보존했다: prisma/schema.prisma 및 신규 migration,
analysis.controller/service/repository, image-analysis.service, http-image-analysis.provider,
신규 image-analysis.error, analysis/http-image-analysis 테스트와 신규 analysis-idempotency 테스트.

## 후속 범위

- Usage는 TODO이므로 실제 과금/차감 성공을 판정하지 않는다. 예약/해제 호출 횟수만 검증했다.
- 운영 타임아웃은 기존 30초 유지. 순차 모델당 120초 가정 시 ALL은 241초 이상이 필요하며
  실제 서버 측정 및 프록시 제한과 합의해야 한다. 외부 AI는 호출하지 않았다.
- DB 장애 시 FAILED 저장 자체는 보장할 수 없으며 실패 정리 오류는 최초 오류를 덮어쓰지 않는다.
- 프로세스 비정상 종료로 남은 처리 중 요청의 자동 재선점/자동 재시도는 구현하지 않았다.
- #89: UUID, 미존재, 소유권, 만료, DB 조회 오류 처리와 DTO/Swagger/테스트는 후속 범위다.
- 기존 DB에는 PB-23 migration을 적용하지 않았다. #7과 통합 배포 시 두 migration 이력을 함께 보존해야 한다.
