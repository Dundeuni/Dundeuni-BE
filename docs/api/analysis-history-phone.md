# PHONE 검사 기록 (#28)

브랜치: `feature/28-history-phone`, 기준: dev `b3ce599`.
공통 History(PR #29) 및 기존 PHONE 분석(PR #20, c0ea6f6)의 필요한 코드를 로컬 패치로 재사용했다.
커밋·머지 없이 dev 기준 브랜치에 보존한 변경이다. TEXT/IMAGE 후속 기능은 포함하지 않았다.

## 생성과 저장

기존 `POST /api/analyses/phone`을 재사용한다. Bearer JWT 인증 후 JSON으로
`{ "phoneNumber": "010-1234-5678" }`를 요청하면 APICK 조회 결과를 저장하고
201 `{ "analysisId": "uuid", "status": "COMPLETED" }`를 반환한다.
요청 형식, 번호 정규화, phone-initial-1 위험 판정 및 UTC 일일 유료 호출 한도 정책을 유지한다.

Analysis의 PHONE 유형과 기존 1:1 PhoneAnalysisResult 관계를 사용한다.
번호는 기존 정책대로 02 또는 3자리 국번만 남기고 나머지를 모두 마스킹한다.
예: `010********`, `02********`. 원문이나 복원 가능한 전화번호 해시는 저장하지 않는다.
requestHash는 기존 구현의 무작위 식별자다. 결과 상태와 관계 데이터는 nested write로 함께 저장한다.
APICK 자유 문자열에 재출력된 번호도 저장 전에 제거한다. 괄호·공백·하이픈·점 및 국제번호 형태를 포함한다.
외부 오류는 고정된 안전 메시지로 변환하고 원문·토큰·외부 오류 내용을 로그에 기록하지 않는다.
APICK 실패 시 마스킹된 FAILED 기록을 유지한다.

기존 PHONE의 expiresAt=생성 후 30일을 유지한다. 조회 시 만료 기록은 제외한다.
물리 삭제 스케줄러와 요금제별 보관 정책은 이번 PHONE 범위에 추가하지 않는다.

## 목록

`GET /api/analysis/history?page=1&limit=20`

JWT 사용자의 미만료 기록만 최신순으로 반환한다. PHONE의 targetSummary는 마스킹 번호이며
aiRiskLevel은 저장된 PhoneAnalysisResult.riskLevel이다. 다른 유형과 같은 목록에 포함한다.

```json
{
  "analysisId": "uuid",
  "type": "PHONE",
  "targetSummary": "010********",
  "status": "COMPLETED",
  "aiRiskLevel": "DANGER",
  "createdAt": "2026-11-22T00:00:00.000Z"
}
```

## 상세

`GET /api/analysis/history/:analysisId`

기존 공통 응답 envelope의 result에는 analysisId/type/status/createdAt/completedAt,
aiGenerationScore=null, aiRiskLevel, reasons(description 배열), 다음 detail을 제공한다.

```json
{
  "maskedPhoneNumber": "010********",
  "riskLevel": "DANGER",
  "reportCount": 1000,
  "reportCountIsRange": true,
  "reasons": ["피싱 유형의 신고 정보가 있습니다. 사기 확정 판정은 아닙니다."],
  "analyzedAt": "2026-11-22T00:00:01.000Z"
}
```

reportCountIsRange=true이면 저장된 1000+ 등의 하한값이다. 출처가 불명확하면 null이다.
누락된 신고 건수는 null이며 0으로 추정하지 않는다. 저장된 SAFE/CAUTION/DANGER/UNKNOWN만 사용하며
현재 정책으로 과거 위험도를 다시 판정하지 않는다. FAILED/결과 관계 없는 기록은 가능한 마스킹 번호만
반환하고 결과 필드는 null/빈 배열로 처리한다.

소유권·만료 검증 후 DB에서 허용 필드만 select하고 명시적 응답 projection을 적용한다.
rawData/normalizedData, 외부 API 키, provider 자유 필드는 응답에 포함하지 않는다.
과거 DB에 원문 번호가 있더라도 응답에서 다시 마스킹하며 식별할 수 없는 형식은 null이다.
저장된 근거의 전화번호도 제거한다. 원문 데이터를 읽어서 자동 수정하는 작업은 하지 않는다.
기록 조회는 APICK 재호출, 사용량 차감, 재분석 및 DB 상태 변경을 하지 않는다.

## 인증·삭제·오류

기록의 공통 JWT Guard를 재사용한다. 401은 무효/누락 JWT, 400은 잘못된 UUID/페이지이며,
없는 기록·타인 기록·만료 기록은 같은 404다.
`DELETE /api/analysis/history/:analysisId` 및 전체 DELETE는 기존 공통 API를 재사용한다.
본인 부모 행만 삭제하고 PHONE 관계는 FK Cascade로 정리한다. 다른 사용자 기록은 유지한다.

## 의존성 및 설정

- Base PR #29의 controller/service/repository/DTO/테스트를 로컬 패치로 적용했다.
- PHONE PR #20의 APICK provider, 분석/usage/risk 서비스, DTO, repository, controller를 재사용했다.
- 기존 PHONE migration `20261106000000_phone_analysis`, `20261118000000_phone_daily_usage`를 그대로 재사용했다.
  통합 시 동일 migration과 서비스를 중복 생성하지 않아야 한다. 추가 전용 기록 테이블은 만들지 않았다.
- 기존 PHONE 의존성 @nestjs/axios와 axios 및 잠금 파일을 재사용했다.
- APICK_AUTH_KEY가 실제 분석에 필요하다. 키를 파일에 기록하지 않았다.
- PHONE_DAILY_LIMIT은 기존 PHONE 기본값 10회/UTC 일자다. 기록 조회에는 적용하지 않는다.
- 기존 IMAGE 생성 기능은 수정하지 않았다. IMAGE/SCREEN/TEXT 상세는 각 후속 브랜치 의존성이다.

## 테스트

격리된 localhost 테스트 DB에 전체 migration을 적용하고 HTTP→Prisma→PostgreSQL 저장·조회·Cascade를 검증한다.
APICK HTTP는 대역으로 교체하며 실제 유료 API를 호출하지 않는다.

```bash
npm run prisma:generate
npm run typecheck
npm run build
HISTORY_DB_URL=postgresql://history_test@127.0.0.1:55440/history_test_2026112228 \
PHONE_DB_URL=postgresql://history_test@127.0.0.1:55440/history_test_2026112228 \
V1_DB_TEST=1 V1_DB_URL=postgresql://history_test@127.0.0.1:55440/history_test_2026112228 \
npm run test:e2e -- --runInBand
```

DB 환경 변수가 없으면 DB 전용 테스트는 skip한다. 운영 DB migration과 실제 APICK 호출은 수행하지 않았다.
