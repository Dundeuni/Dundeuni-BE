# PB-04 전화번호 분석

POST `/api/analyses/phone`, 로그인 및 Authorization 헤더 불필요. 시연 기록은 공통 `development-user`로 저장한다.

```json
{"phoneNumber":"010-1234-5678"}
```

201 응답 (기존 Analysis PK인 UUID 재사용; 숫자 ID를 새로 만들지 않음):

```json
{"analysisId":"d734f69e-ce2e-4914-8a2e-230713d37c96","status":"COMPLETED"}
```

Swagger: `/api/docs`. 기존 오류 envelope 재사용. 사용자 로그인 인증은 적용하지 않는다. APICK 서비스 인증은 서버에서 유지한다.
입력 오류 `INVALID_PHONE_NUMBER`(400), APICK 연결/서버/타임아웃/계약 오류 `EXTERNAL_API_UNAVAILABLE`(503),
포인트/한도 `APICK_QUOTA_EXCEEDED`(503), 외부 인증 오류 `APICK_AUTHENTICATION_FAILED`(503),
키 미설정 `APICK_CONFIGURATION_ERROR`(500), DB 오류 `INTERNAL_SERVER_ERROR`(500).
외부 오류 원문을 응답이나 로그로 출력하지 않는다.

## 외부 계약과 설정

공식 문서: https://apick.app/dev_guide/check_spam_number (2026-11-06 확인).
`POST https://apick.app/rest/check_spam_number`, multipart `number`, 10초 timeout, 자동 재시도/redirect 없음.
키는 `process.env.APICK_AUTH_KEY`. `.env`를 변경하지 않는다.
요청한 `CL_AUTH_KEY`와 최신 공식 가이드의 `Authorization: Bearer`를 같은 키로 전송한다.
응답은 `data`와 `api` envelope. `api.success=true` 및 `data.success=1` 모두 필요.
포인트 부족은 HTTP 200의 `result.error`로도 올 수 있다.

## 초기 정책 phone-initial-1

- DANGER: `spam`이 `보이스피싱` 또는 `SMS 피싱`과 정확히 일치.
- CAUTION: 다른 스팸 유형이 있거나 신고 건수 하한이 1 이상.
- 사이버 범죄 문구는 공식 부정 문구 및 `<미확인>`을 별도 처리한다. 다른 안내 문구는 확인 필요 근거를 추가하고 최소 CAUTION으로 분류한다. 범죄 존재를 단정하지 않는다.
- UNKNOWN: 이력 없음, 정보 누락, 미확인. SAFE는 초기 정책에서 산출하지 않는다.
- 신고 건수만으로 DANGER나 사기 확정을 하지 않는다. 임의의 대량신고 임계값 없음.
- 정책은 `PHONE_RISK_POLICY`에 버전과 함께 분리. 신고 시점·번호 재할당 가능성 때문에 결과는 확정 판정이 아니다.

## 저장 및 PB-05 재사용

기존 Analysis에 PHONE enum 및 1:1 PhoneAnalysisResult 연결 추가.
Analysis는 userId, 상태, errorCode, createdAt, completedAt, expiresAt(30일)을 보관.
전화번호는 국번 이외 전체 마스킹. 원문/복원 가능한 해시를 저장하지 않는다.
요청 해시는 무작위 식별자이며 전화번호 중복 판정용이 아니다.
초기 Analysis와 결과 행은 nested create로 원자적 저장. 완료 결과와 상태도 nested update로 함께 저장.
외부/완료 저장 실패는 FAILED 기록을 시도하며, DB 자체가 불능이면 상태 기록도 불가능할 수 있다.

PhoneAnalysisResult에는 provider=APICK, phoneNumber(마스킹), riskLevel, spamType, reportCount,
reportCountRaw, cyberCrime, reasons, policyVersion, analyzedAt, createdAt 저장.
rawData는 번호를 제외한 허용 필드만 보관한 응답 projection이고 전체 wire 응답은 아니다.
문자열 내 예상치 못한 전화번호도 제거한다.
normalizedData에 registeredDate, success, reportCountIsRange 포함.
`1000+`는 reportCount=1000과 reportCountRaw='1000+', 범위 표시를 함께 저장하여 정확한 건수로 오해하지 않는다.
필드 누락/null은 null, 잘못된 타입/건수는 계약 오류. 제공되지 않은 정보를 생성하지 않는다.
PB-05는 소유권·만료 검사 후 이 관계를 읽는 방식으로 확장할 수 있다. 이번 변경에는 조회 API가 없다.

## 배포 및 검증

`npm ci`, `npm run prisma:generate`, `npm run prisma:migrate`, `npm run build`.
새 migration: `20261106000000_phone_analysis`. 운영 DB 적용 전 통상적인 migration 검토 필요.
기존 worktree의 다른 브랜치 테스트가 수집되지 않도록 Jest roots를 현재 `test`로 제한했다.
`npm test -- --runInBand`는 실제 APICK 요청을 하지 않으며 HTTP와 DB를 mock한다.
실제 DB migration 적용 및 유료 APICK 연동 검증은 자동 테스트와 별개다.

수동 통합 검증은 운영 설정과 분리한 환경에서 키를 설정하고 migration을 적용한 뒤,
Swagger에서 검증할 번호로 위 요청을 실행한다. **APICK 포인트가 소모될 수 있다.**
201 응답 및 DB의 COMPLETED/마스킹/정규화 필드를 확인한다.
이 작업 중 실제 APICK 호출과 실제 DB migration 적용은 수행하지 않았다.
