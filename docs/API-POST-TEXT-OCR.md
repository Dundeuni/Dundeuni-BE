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

TEXT와 캡처는 Analysis.type=TEXT로 저장하고 완료 응답 메타데이터를 textResult에 저장한다. 원본 TEXT·OCR echo·evidence/limitations·이미지는 새로 저장하지 않는다. 직접 입력은 기존 200자 preview 정책을 유지하고 캡처 preview는 빈 문자열이다. 30일 만료 및 원본 버퍼 정리를 유지한다. 캡처 생성 시 textResult={sourceType:SCREEN_CROP} 메타데이터만 먼저 저장하여 QUEUED/ANALYZING/FAILED 상태도 입력 출처를 보존한다. 완료 시 검증된 결과로 교체하며 schema/migration 변경은 없다. 이 메타데이터는 AI 분석 결과를 의미하지 않는다.

인증은 #15에 공통 RequestUserGuard를 배치한다. 명시적인 development에서만 development-user를 사용하고 토큰이 있어도 같은 사용자로 처리한다. production 및 그 외 환경은 기존 HS256 JWT Guard의 sub를 사용한다. 프로세스 NODE_ENV=production이면 ConfigService가 development여도 우회하지 않는다. #17 GET은 같은 Guard를 재사용한다.

Swagger는 미디어 타입별 스키마를 분리하고 멱등성 키를 선택 헤더 하나로 제공한다. multipart에서 IMAGE는 sourceType 필드 자체를 생략하고, TEXT는 SCREEN_CROP을 선택한다. 문자열은 DIRECT 또는 생략. 멱등성·AI 인증·timeout/abort·오류 변환·AI 컨텍스트 검증·기존 IMAGE 모델별 저장을 유지한다.

테스트는 POST 요청 검증, AI HTTP 전송, 결과 저장을 검사하며 #15 테스트는 GET 구현을 요구하지 않는다. 실제 OCR 엔진 및 피싱 모델의 연속 실행은 AI 서버 구현의 책임이고 Mock 응답 검증으로 실추론 성공을 주장하지 않는다.
