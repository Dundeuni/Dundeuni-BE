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
→ Usage 예약 연동 지점 → ANALYZING → Provider 호출 → 결과 저장(COMPLETED)
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

이 예시는 계약 설명용이며 현재 운영 Provider는 가짜 점수를 반환하지 않는다.
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
| 503  | ANALYSIS503 | Provider 미연동/장애/잘못된 결과                    |
| 500  | COMMON500   | DB 저장 실패, 내부 오류, 정책/인증 설정 누락        |

### DB·개인정보

클라이언트의 `Idempotency-Key` 헤더는 사용하지 않는다. 재전송도 별도의 분석 요청으로 처리한다.
기존 DB 스키마의 idempotencyKey 필드는 요청마다 서버가 생성하는 UUID로 채운다.
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

- `IMAGE_ANALYSIS_PROVIDER`: 실제 AI 분석 연결. 랜덤/고정 가짜 결과 없음.
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
