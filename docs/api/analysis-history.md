# 검사 기록 공통 API (P0)

분석 실행 직후 결과 조회와 별개인 과거 기록 관리 API다. 공통 prefix는 `main.ts`의 `/api`이고
Controller 경로는 `analysis/history`다. `AnalysisModule`은 History Controller를 기존 Analysis Controller보다
먼저 등록하므로 후속 `GET /analysis/:analysisId`와 `/history`가 충돌하지 않도록 한다.

## 인증과 응답

모든 경로에 기존 `AccessTokenGuard`를 적용하며 개발 환경에서도 JWT Bearer가 필수다.
HS256 검증 후 `sub`를 사용자 ID로 사용한다. 공용 개발 사용자나 query/body의 사용자 ID를 사용하지 않는다.
응답은 기존 공통 envelope를 따른다.

```json
{
  "isSuccess": true,
  "code": "ANALYSIS200",
  "message": "검사 기록 목록 조회에 성공했습니다.",
  "result": {
    "items": [],
    "page": 1,
    "limit": 20,
    "total": 0,
    "hasNext": false
  }
}
```

- 400 `COMMON400`: 잘못된 UUID/페이지 번호/크기/offset 범위
- 401 `AUTH401`: JWT 누락·무효·만료
- 404 `COMMON404`: 없는 기록, 다른 사용자 기록, 조회 시 만료·삭제된 기록
- 500 `COMMON500`: 인증 설정 또는 DB/내부 오류. 내부 오류 원문은 노출하지 않는다.

오류의 `isSuccess=false`, `result=null` 규약을 유지한다. 4개 API의 Request/Response DTO,
Bearer 인증 및 오류는 Swagger `/api/docs`에 문서화한다.

## GET /api/analysis/history

`page` 기본 1, `limit` 기본 20. 둘 다 양의 정수다. 페이지 크기는 최대 100이며
이는 요청별 페이지 크기 제한으로 요금제의 기록 보관 개수 제한이 아니다.
Prisma 정수 offset을 초과하면 400이다. 범위를 벗어난 페이지는 빈 items와 실제 total을 반환한다.

`userId`와 `expiresAt > now`를 DB에서 필터링한다. 날짜 경계의 같은 `now`를 두 조회에 적용한다.
`createdAt DESC, id DESC`로 정렬하여 동일 생성 시각도 순서가 고정된다.
`items`와 `total`은 PostgreSQL Repeatable Read 트랜잭션의 같은 스냅샷에서 조회한다.
기록이 없으면 `items=[]`, `total=0`, `hasNext=false`다.

각 항목은 `analysisId`, `type`, `targetSummary`, `status`, `aiRiskLevel`, `createdAt`만 반환한다.
현재 dev에는 원문·파일명·대상 요약 저장 필드가 없으므로 `targetSummary=null`이다.
원본이나 해시에서 대상 요약을 생성하지 않는다. 위험도는 저장된 nullable 문자열을 그대로 사용한다.
유형 필터를 고정하지 않아 통합된 Analysis 유형 전체를 조회한다.

## GET /api/analysis/history/:analysisId

본인·미만료 기록만 조회하며 외부 분석 서비스를 재호출하지 않는다. DB에서 선택한 공통 필드만 반환한다.

```json
{
  "isSuccess": true,
  "code": "ANALYSIS200",
  "message": "검사 기록 상세 조회에 성공했습니다.",
  "result": {
    "analysisId": "00000000-0000-4000-8000-000000000001",
    "type": "IMAGE",
    "status": "COMPLETED",
    "aiGenerationScore": 75,
    "aiRiskLevel": null,
    "reasons": [{ "description": "저장된 분석 근거" }],
    "createdAt": "2026-11-21T10:00:00.000Z",
    "completedAt": "2026-11-21T10:00:01.000Z",
    "detail": null
  }
}
```

진행 중·실패 기록도 저장 상태 그대로 반환하며 없는 점수/완료 시각/근거를 만들지 않는다.
`reasons`는 저장된 description만 허용하고 임의 JSON 내부 필드를 내보내지 않는다.
`userId`, `requestHash`, raw payload, 원본 이미지, 내부 모델 필드는 노출하지 않는다.
유형별 상세 데이터는 후속 브랜치에서 `detail`을 확장하며 현재는 `null`이다.

## DELETE /api/analysis/history/:analysisId

현재 사용자의 지정 ID에 대해 조건부 `deleteMany` 한 번으로 소유권 검사와 삭제를 원자적으로 처리한다.
다른 사용자·없는 ID·이미 삭제된 ID는 동일한 404다. 만료된 본인 기록도 정리할 수 있다.
별도 조회 후 삭제하는 방식의 소유권/동시성 경합을 피한다. 성공은 HTTP 200:

```json
{"isSuccess":true,"code":"ANALYSIS200","message":"검사 기록 삭제에 성공했습니다.","result":{"deletedCount":1}}
```

## DELETE /api/analysis/history

사용자 조건이 있는 일괄 DELETE 한 번으로 해당 사용자의 모든 기록을 삭제한다.
만료 여부와 무관하게 삭제하며 다른 사용자 기록은 유지한다. 빈 기록도 200/`deletedCount=0`이다.
삭제 후 목록/상세에 즉시 반영된다. 확인 모달은 프론트엔드 책임이다.
기존 `AnalysisModelResult.analysis` FK의 `ON DELETE CASCADE`로 모델 결과도 정리한다.
새 테이블이나 migration은 필요하지 않다.

## 재사용과 후속 의존성

- dev 기준 커밋: `b3ce599`.
- 기존 `Analysis` 테이블, `AnalysisModelResult` 관계/Cascade, JWT Guard, ApiError/ApiErrorFilter,
  `/api` prefix 및 공통 응답 규약을 재사용한다.
- 현재 dev에는 공개 분석 결과 상세 GET/조회 Service가 없다. 다른 기능 브랜치 구현을 복제하거나
  병합하지 않고 전용 History 조회 projection만 구현했다.
- 현재 dev의 AnalysisType은 `IMAGE/TEXT/URL`이다. SCREEN/PHONE은 각 기능 브랜치가 enum과 저장 기능을
  통합한 후 같은 통합 목록에 포함된다. 이 브랜치에서 enum을 임의로 추가하거나 유형을 위장하지 않는다.
- IMAGE/SCREEN 모델별 상세, TEXT 결과, PHONE 마스킹 대상 요약/위험도/상세는 각 기능 브랜치의 후속 범위다.
  후속 테이블의 삭제 Cascade와 응답 개인정보 projection도 통합 시 확인해야 한다.
- 요금제/구독 모델과 요금제별 기록 기간·개수 정책은 정의되어 있지 않다. 임의 무료/유료 제한은 추가하지 않는다.
  현재 생성 시 `ANALYSIS_RETENTION_SECONDS`로 저장된 expiresAt만 적용한다. `.env.example`의 86400은 개발용 제안값이다.
  기존 행의 보관 기한을 변경하거나 신규 TTL 정리 작업을 추가하지 않는다.
- 사용량 정책과 이력 기록 동의/요금제 변경 시 소급 정책은 별도 정의가 필요하다.

## 검증

```bash
npm run typecheck
npm run build
npm run test:e2e -- --runInBand
git diff --check
```

실제 DB 검증은 합성 데이터만 사용하는 로컬 전용 `history_test_<숫자>` DB에 dev migration을 적용하고:

```bash
HISTORY_DB_URL=postgresql://test_user@127.0.0.1:55440/history_test_20261121 \
V1_DB_TEST=1 V1_DB_URL=postgresql://test_user@127.0.0.1:55440/history_test_20261121 \
npm run test:e2e -- --runInBand
```

`HISTORY_DB_URL`이 없으면 PostgreSQL 전용 suite는 opt-in으로 남는다.
현재 테스트 디렉터리만 수집하도록 Jest roots를 지정하여 다른 worktree 테스트를 실행하지 않는다.
외부 AI를 호출하지 않으며, 실제 DB에서 부모 삭제/결과 Cascade/다른 사용자 보존/동시 개별 삭제를 확인한다.
