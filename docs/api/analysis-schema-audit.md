# #92 분석 데이터 모델 점검

검토 기준: 2026-10-15, `feature/#3-image-analysis`.
다른 브랜치의 #89/#97 구현을 현재 브랜치에 포함된 것으로 간주하지 않았다.
스키마·기존 Migration·기존 데이터는 변경하지 않았으며 새 Migration도 생성하지 않았다.

## 현재 모델과 #5 관련 구현

`7a4a408`(AI v1 이미지 분석 DTO 및 Prisma 스키마 확장)에 모델별 결과와 요약 저장 필드가 포함되어 있다.
#5의 원문/확정 명세는 저장소에 없고 커밋 메시지에도 이슈 번호가 없어 이슈 전체 완료 여부는 단정할 수 없다.
현재 코드로 확인되는 v1 구조 준비 항목은 다음과 같다.

| 구조 | 확인 결과 |
| --- | --- |
| Analysis | UUID PK, userId, type/status, 레거시 결과, 생성/완료/만료 시각 |
| AnalysisModelResult | 모델 종류별 결과, Analysis FK, `(analysisId, kind)` UNIQUE |
| 모델 결과 | status, nullable decision/displayScore, reasons JSON, limitations 문자열 배열, 모델/정책 버전, errorCode/retryable |
| Gemini 요약 저장 필드 | summaryStatus, summary, summaryModel, summarizedAt 모두 nullable |
| 분석 상태 | QUEUED / ANALYZING / COMPLETED / FAILED |
| 모델 실행 상태 | SUCCEEDED / FAILED |
| 모델 집계 상태 | COMPLETED / PARTIAL_FAILED / FAILED |

## 확인된 차이·누락

1. AnalysisType은 IMAGE/TEXT/URL이다. SCREEN은 DTO 설명/검증 목록에 있으나 DB enum에는 없다.
   현재 공개 API는 IMAGE만 처리하고 SCREEN/TEXT는 400이므로 현재 경로의 저장 오류는 없다.
   TEXT는 DB 표현은 가능하지만 분석 실행 구현은 없다. SCREEN 저장 지원을 위해서는 enum 확장이 필요하다.
2. 모델별 결과 저장/관계 조회와 요약 필드 저장 메서드는 있으나 Gemini Worker, Client, 영속 작업 큐는 이 브랜치에 없다.
   summaryStatus만으로 실행 선점·재시도 횟수·lease를 관리할 수 있다고 볼 수 없다.
   따라서 Worker 런타임 호환성은 이 브랜치에서 검증할 수 없다. Worker 코드를 포함할 때 요구 스키마를 다시 대조해야 한다.
3. overallResult 저장 컬럼과 종합 판정 계산 함수는 이 브랜치에 없다.
   저장된 모델별 status/decision을 이용해 계산할 수 있으므로 계산 방식 채택 시 컬럼 추가는 필요 없다.
   점수를 합산할 필요도 없다. 실제 계산 구현/연동은 별도 작업이다.
4. 상세 GET/History API는 없다. `findWithModelResults(id)`는 소유권/만료를 확인하지 않는 내부 Repository 메서드다.
   외부 API 호출자는 userId와 expiresAt 조건을 적용해야 한다.
5. userId는 문자열이며 현재 User 테이블/FK는 없다. 임시 인증 상태를 유지한다.

## 무결성 검토

- AnalysisModelResult.analysisId FK는 Analysis 삭제 시 CASCADE다. 이번 점검에서는 삭제를 수행하지 않는다.
- `(analysisId, kind)` UNIQUE와 upsert로 같은 분석·모델 종류의 중복 행을 방지한다.
- SQL CHECK는 displayScore 범위 0~100, 성공 모델의 errorCode=null,
  실패 모델의 비어 있지 않은 errorCode 및 decision/displayScore=null을 보장한다.
- 성공 모델은 decision이 필수이며 INCONCLUSIVE + displayScore=null을 저장할 수 있다.
- reasons 원소 구조와 limitations 내용은 Repository에서 검증한다.
  SQL에서는 reasons JSON 배열 구조를 강제하지 않고 limitations 컬럼은 nullable TEXT[]다.
  타입/요약 상태별 필드의 전체 일관성이 DB CHECK로 모두 보장되는 구조는 아니다.
  현재 코드 경로는 검증된 배열 및 상태별 null 정리를 사용하므로 이를 이유로 즉시 Migration을 추가하지 않는다.
- rawScore와 원본 이미지/localization 저장 컬럼은 없다.
- imageResultStatus는 최근 전달된 모델 응답의 집계 상태이고 BE status와 별개다.
  saveModelResults는 BE status/completedAt을 변경하지 않으므로 호출자가 작업 상태 전이를 별도로 처리해야 한다.

## History 지원

새 테이블 없이 Analysis로 목록/요약 상세/최근 3건을 조회하고 modelResults를 관계 조회할 수 있다.
완료 요약 목록의 필터 예시는 다음과 같다. PENDING/FAILED 포함 여부는 #98 계약에서 확정해야 한다.

```ts
const where = {
  userId,
  expiresAt: { gt: new Date() },
  summaryStatus: 'COMPLETED' as const,
};
const orderBy = [
  { createdAt: 'desc' as const },
  { id: 'desc' as const },
];
const recent = await prisma.analysis.findMany({ where, orderBy, take: 3 });
// 다음 페이지: 같은 where/orderBy + cursor: { id: lastId }, skip: 1
```

같은 createdAt에서 id DESC를 tie-breaker로 사용하면 결정적인 순서를 얻는다.
UUID 역순은 생성 시각 자체를 나타내지 않으며 createdAt이 주 정렬 기준이다.
현재 PK 인덱스는 ID 상세 조회에 유효하지만 userId 필터 + createdAt/id 정렬을 함께 지원하는 복합 인덱스는 없다.
작은 데이터에서도 조회 자체는 가능하며 데이터 증가 시 성능 검증이 필요하다.

## 승인 후 검토할 새 Migration 변경안 (미생성·미적용)

| 제안 | 영향 및 적용 전 확인 |
| --- | --- |
| AnalysisType에 SCREEN 추가 | 기존 IMAGE/TEXT/URL과 기존 행 보존. URL을 SCREEN으로 rename/변환하지 않는다. API 처리 지원은 별도 구현 필요. PostgreSQL enum 변경은 배포/트랜잭션 방식 검토 필요 |
| `@@index([userId, createdAt(sort: Desc), id(sort: Desc)])` | 사용자별 History 정렬·최근 3건 조회 최적화 후보. 데이터 변경 없음. 인덱스 저장공간·생성 부하/잠금, 운영 데이터 EXPLAIN을 확인하고 적용 방식 결정 |

summaryStatus 필터가 고정된다면 해당 열 포함 인덱스나 부분 인덱스는 #98 쿼리 확정·실행 계획을 보고 비교한다.
expiresAt 인덱스는 자동 정리 작업을 실제 도입할 때 검토하며 이번에는 추가하지 않는다.
기존 구조로 가능한 History를 위해 별도 테이블을 만들지 않는다.

## 보관기간

AnalysisService는 `ANALYSIS_RETENTION_SECONDS`의 양의 정수 설정으로 expiresAt을 생성한다.
createdAt은 DB 기본값, completedAt은 분석 complete/fail 처리 시 기록한다.
summaryStatus는 미생성=null, 작업 시작=PENDING, 완료=COMPLETED, 실패=FAILED로 저장할 수 있다.
saveSummary는 PENDING/FAILED 시 요약·모델·시각을 null로 정리한다.
보관 기한 기록과 자동 삭제/조회 차단은 별개다. 현재 자동 TTL 삭제·동의 기록은 미구현이다.
History 외부 조회에서 만료 제외 정책과 기록 동의/보관/삭제 정책을 확정해야 한다.

## 검증

- `prisma validate`: 현재 Schema 유효성.
- Prisma Client 재생성 및 TypeScript 검사: 현재 저장/관계 조회/요약 필드 타입 호환성.
- 기존 API·Repository 회귀 테스트.
- 기존 Migration 체인을 localhost 임시 스키마에만 실행하는 DB 통합 테스트:
  모델 FK/UNIQUE, 반복 upsert 행 ID 유지, 상태별 DB CHECK, 요약 전이와 분석 데이터 보존,
  사용자·만료·완료 요약 필터, 동일 createdAt의 ID 역순, 최근 3건·cursor 다음 페이지·상세 조회.
- 기존 Migration 체인과 Prisma Schema의 diff 및 SQL CHECK 동작을 각각 확인한다.
- 배포/기존 데이터 스키마에 Migration을 적용하거나 기존 행을 수정하지 않는다.
