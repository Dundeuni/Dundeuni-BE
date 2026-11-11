# Issue #15 — 분석 POST와 TEXT/OCR 공개 계약

#10 IMAGE HTTP 연동과 #13 TEXT 입력 기능을 유지하면서 기존 `POST /api/analysis`를 확장한다. 상세 GET 및 응답 정규화는 #17 범위이며 #15에는 포함하지 않는다.

| 요청 | Content-Type | Provider | 내부 endpoint |
| --- | --- | --- | --- |
| type=IMAGE, file (sourceType 금지) | multipart/form-data | ImageAnalysisService / HttpImageAnalysisProvider | /internal/v1/image-analyses, models=ALL |
| type=TEXT, sourceType=DIRECT 또는 생략, text | application/json | TextAiWorkflowService / HttpTextAnalysisProvider.analyze | /internal/v1/text-analyses |
| type=TEXT, sourceType=SCREEN_CROP, file | multipart/form-data | TextAiWorkflowService / HttpTextAnalysisProvider.analyzeImage | /internal/v1/text-analyses/image |

sourceType 생략은 #13과 기존 #15 JSON 요청의 하위 호환을 위해 DIRECT로 해석한다. 파일 유무로 캡처를 추정하지 않는다. TEXT+file에는 SCREEN_CROP이 필수이며 공개 DIRECT는 AI 내부 TEXT에 대응한다. `AnalysisType`은 IMAGE/TEXT/URL이며 SCREEN_CROP을 추가하지 않는다. `sourceType`은 공개 DTO의 DIRECT/SCREEN_CROP이다.

SCREEN_CROP에 text만 전달하거나 file을 누락하면 400. DIRECT에 file, IMAGE에 sourceType/text, 지원하지 않는 sourceType, 중복 type/sourceType과 text/file 동시 입력도 400. 기존 TEXT의 trim 및 Unicode 5~3,000자 제한을 유지한다. Multer는 type/sourceType 2개 필드와 1개 파일을 수용한다. IMAGE와 OCR은 기존 확장자·MIME·시그니처·디코딩·업로드 제한을 공유하며 OCR은 AI의 10MiB 제한도 DB 삽입 전에 검사한다.

TEXT AI는 TEXT_AI_PROVIDER=http일 때 활성화되며 AI_SERVICE_BASE_URL을 사용한다. IMAGE는 AI_PROVIDER=http과 AI_SERVER_BASE_URL을 사용한다. 토큰·환경파일을 Git에 포함하지 않는다. JSON의 AI 요청은 text/analysisId/elementId, OCR의 AI 요청은 file/analysisId/elementId/sourceType=SCREEN_CROP이다. OCR 서버가 피싱 결과를 함께 반환하므로 BE에서 문자열 API를 중복 호출하지 않는다.

TEXT와 캡처는 Analysis.type=TEXT로 저장하고 완료 응답 메타데이터를 textResult에 저장한다. 검증된 evidence·limitations 배열은 textResult에 저장·응답한다. 원본 TEXT·OCR echo·이미지는 새로 저장하지 않는다. 직접 입력은 기존 200자 preview 정책을 유지하고 캡처 preview는 빈 문자열이다. 30일 만료 및 원본 버퍼 정리를 유지한다. 캡처 생성 시 textResult={sourceType:SCREEN_CROP} 메타데이터만 먼저 저장하여 QUEUED/ANALYZING/FAILED 상태도 입력 출처를 보존한다. 완료 시 검증된 결과로 교체하며 schema/migration 변경은 없다. 이 메타데이터는 AI 분석 결과를 의미하지 않는다.

인증은 #15에 공통 RequestUserGuard를 배치한다. 명시적인 development에서만 development-user를 사용하고 토큰이 있어도 같은 사용자로 처리한다. production 및 그 외 환경은 기존 HS256 JWT Guard의 sub를 사용한다. 프로세스 NODE_ENV=production이면 ConfigService가 development여도 우회하지 않는다. #17 GET은 같은 Guard를 재사용한다.

Swagger는 미디어 타입별 스키마를 분리하고 멱등성 키를 선택 헤더 하나로 제공한다. multipart에서 IMAGE는 sourceType 필드 자체를 생략하고, TEXT는 SCREEN_CROP을 선택한다. 문자열은 DIRECT 또는 생략. 멱등성·AI 인증·timeout/abort·오류 변환·AI 컨텍스트 검증·기존 IMAGE 모델별 저장을 유지한다.

테스트는 POST 요청 검증, AI HTTP 전송, 결과 저장을 검사하며 #15 테스트는 GET 구현을 요구하지 않는다. 실제 OCR 엔진 및 피싱 모델의 연속 실행은 AI 서버 구현의 책임이고 Mock 응답 검증으로 실추론 성공을 주장하지 않는다.

## TEXT AI 실패 진단 로그

텍스트 및 캡처 AI 호출 실패는 `TextAiWorkflowService`에서 WARN 이벤트
`TEXT_AI_CALL_FAILED`로 기록한다. 필드는 `analysisId`, `sourceType`, `endpoint`,
`failureKind`, `upstreamStatus`, `durationMs`다. HTTP 응답을 받지 못한 네트워크 실패·시간 초과의
`upstreamStatus`는 null이며, HTTP 200 응답의 JSON/계약 검증 실패는 200으로 기록한다.
`failureKind`는 UPSTREAM, NETWORK, TIMEOUT, INVALID_RESPONSE로 구분한다.
토큰, 사용자 ID, 입력 문자열·이미지, upstream 응답 본문 및 원본 예외 메시지는 출력하지 않는다.
공개 API의 503/ANALYSIS503 응답 계약은 유지한다.

추가 진단 필드: `startedAt`(UTC ISO 시각), `upstreamHost`(실제 호출 호스트와 포트),
`upstreamPath`(호출 경로), `ngrokErrorCode`(응답의 `ngrok-error-code`, 없으면 null).
오류 헤더는 숫자 또는 ERR_NGROK_숫자 형식만 허용하며 임의 헤더 값은 출력하지 않는다.
FE에서 새 분석을 한 번 요청하고 `startedAt`과 ngrok 요청 기록을 대조한다.

정상 처리 로그(LOG): AI 요청 직전에 `TEXT_AI_CALL_STARTED`, 응답 검증과 DB 결과 저장이
모두 끝나면 `TEXT_AI_CALL_SUCCEEDED`를 기록한다. 공통으로 analysisId, sourceType,
startedAt(UTC), upstreamHost, upstreamPath를 포함한다. 성공 로그에는 upstreamStatus=200,
저장된 status, durationMs를 추가하며 판정 결과·원문은 출력하지 않는다.
멱등성 키로 완료 결과를 재조회하면 새로운 AI 호출이 없으므로 호출 로그도 추가하지 않는다.

## 텍스트 분석 근거 응답

문자열·OCR 모두 POST /api/analysis의 `result.textResult.evidence`에 AI가 반환한
검증된 문자열 배열을 포함한다. 같은 값을 저장하므로 멱등성 재요청과
GET /api/analysis/{analysisId}, GET /api/history/{analysisId}에서도 조회할 수 있다.
근거가 없으면 빈 배열이며 근거를 추가 생성하지 않는다. 기존 기록에 누락된 evidence는
소급 복원하지 않으므로 FE는 `textResult.evidence ?? []`로 처리한다. DB migration은 없다.

`limitations`도 `result.textResult.limitations`에 AI가 제공한 문자열 배열 그대로 포함하며
저장·상세 조회·멱등성 재응답에서 보존한다. 기존 기록은 `limitations ?? []`로 처리한다.
빈 배열은 추가 제공된 주의사항이 없다는 의미이며 분석 한계가 없다는 뜻은 아니다.
