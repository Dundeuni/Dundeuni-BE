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

TEXT 직접 입력과 OCR은 모든 환경에서 JWT Bearer가 필요하며 JWT의 sub로 분석을 저장합니다. IMAGE는 기존 개발용 인증 정책을 따릅니다.

Swagger는 미디어 타입별 스키마를 분리하고 멱등성 키를 선택 헤더 하나로 제공한다. multipart에서 IMAGE는 sourceType 필드 자체를 생략하고, TEXT는 SCREEN_CROP을 선택한다. 문자열은 DIRECT 또는 생략. 멱등성·AI 인증·timeout/abort·오류 변환·AI 컨텍스트 검증·기존 IMAGE 모델별 저장을 유지한다.

테스트는 POST 요청 검증, AI HTTP 전송, 결과 저장을 검사하며 #15 테스트는 GET 구현을 요구하지 않는다. 실제 OCR 엔진 및 피싱 모델의 연속 실행은 AI 서버 구현의 책임이고 Mock 응답 검증으로 실추론 성공을 주장하지 않는다.


## #33 전화번호 선택 분석

`POST /api/analysis`의 HTTP 202 TEXT·OCR 응답에는 아래 형태의 `result.extractedPhoneNumbers`가 추가됩니다. 기존 `textResult` 구조와 IMAGE 응답은 유지합니다. TEXT·OCR 응답에는 `Cache-Control: no-store`를 설정합니다.

```json
[
  {"phoneNumber":"01012345678","displayNumber":"010-1234-5678","source":"TEXT"},
  {"phoneNumber":"021234567","displayNumber":"02-123-4567","source":"TEXT"}
]
```

- 직접 TEXT는 전체 검증 입력에서 추출합니다. 동일 본문과 Idempotency-Key로 완료 결과를 재사용할 때도 같은 입력에서 재추출합니다. AI 비활성 QUEUED 응답에도 번호가 포함될 수 있습니다. AI 비활성 모드의 키 처리 정책은 기존과 같습니다.
- OCR은 검증된 AI 응답의 `text`에서만 추출하고 `source`는 `OCR`입니다. 빈 텍스트, 낮은 OCR 신뢰도 또는 완료 OCR 요청의 멱등성 재응답은 `[]`입니다. 누락 문자를 보정하거나 재응답을 위해 OCR을 호출하지 않습니다.
- #19 정책이 허용하는 국내 이동전화·지역전화·070을 지원합니다. 공백, 하이픈, 붙여쓰기, 괄호 지역번호, `+82`를 처리합니다. 대표번호와 `050` 등 #19 정책 밖의 번호는 제외합니다. 정규화 번호를 기준으로 첫 발견 순서대로 중복을 제거해 최대 10개를 반환합니다. 미검출과 무효 번호만 있는 경우 모두 `[]`입니다.
- 날짜·식별 번호의 일부와 계좌번호·주문번호 등으로 표시된 후보는 제외합니다. 전화번호와 형태가 같고 문맥이 없는 숫자의 용도는 확정할 수 없습니다.
- 추출 목록과 OCR 원문은 저장하지 않습니다. 기존 TEXT `textPreview`에는 입력의 앞 200자에 전화번호가 있으면 그대로 포함될 수 있습니다. 이 미리보기 정책은 별도 협의 대상입니다.

FE는 최초 POST의 목록을 화면 상태에 보관하고 `displayNumber`를 표시합니다. 목록이 비면 영역을 숨기고, 상세를 다시 조회할 때 이미 확보한 목록을 덮어쓰지 않습니다. 사용자가 선택하면 요청 중 버튼을 비활성화하고 선택한 한 항목의 `phoneNumber`만 기존 `POST /api/analyses/phone`에 JWT와 함께 보냅니다.

```json
{"phoneNumber":"01012345678"}
```

기존 전화번호 API의 HTTP 201 응답 예시입니다.

```json
{"analysisId":"d734f69e-ce2e-4914-8a2e-230713d37c96","status":"COMPLETED"}
```

전화번호 API는 #19에 있으며 JWT 실패는 401, 유효하지 않은 번호는 400, 사용자별 일일 한도 초과는 429, 외부 연동 실패는 기존 503 계약을 따릅니다. #28 통합 배포에서는 반환된 ID로 `GET /api/analysis/history/{analysisId}`의 마스킹된 PHONE 상세를 조회합니다. 추출 경로는 APICK을 호출하거나 전화번호 검사 이용량을 차감하지 않습니다.

#33은 #15를 기반으로 하며 전화번호 API 자체는 #19·#28 통합 배포에 의존합니다. 통합 시 #19의 `normalizePhone`을 공통 파일로 연결해 정책 구현을 한 곳에 유지합니다. 기존 AI 내부 요청/응답 계약 및 DB 스키마를 사용합니다.
