# Issue #17 — PB-05 GET 신규 구현 및 분석 결과 정규화

## 책임과 의존성

#15의 [분석 POST·OCR 계약](API-POST-TEXT-OCR.md)을 기반으로 `GET /api/analysis/{analysisId}`를 신규 구현한다. #15에는 기존 상세 GET이 없었다. 공개 sourceType 검증, OCR Provider 호출 및 저장, POST Swagger·테스트는 #15에 배치하고 #17에서는 재사용한다.

#17의 고유 구현은 GET Controller, Service 조회, Repository의 소유권·만료 조회, 공통 DTO/Mapper, 조회 Swagger·테스트다. 공통 RequestUserGuard는 POST와 GET이 모두 필요하므로 #15에 둔다. branch/worktree 및 분리 패치는 [분리 보고서](ISSUE-15-17-SPLIT.md)를 참고한다.

## 요청과 응답

`GET /api/analysis/{analysisId}`. 본인 소유의 만료 전 기록만 조회한다. 잘못된 UUID는 400 COMMON400, 인증 실패는 401 AUTH401, 미존재/다른 사용자/만료는 동일한 404 ANALYSIS404, DB 오류는 500 COMMON500이다. development에서는 공통 Guard가 development-user를 쓰고 그 외 환경은 JWT sub를 사용한다. production 프로세스에서 개발 우회는 허용되지 않는다.

응답 래퍼는 `{isSuccess:true, code:"ANALYSIS200", message, result:{...}}`다. 바깥 result는 analysisId/type/sourceType/status, 기존 IMAGE 레거시 필드(aiGenerationScore/aiRiskLevel/reasons/modelVersion), errorCode/imageResultStatus/modelResults, createdAt/updatedAt/completedAt/expiresAt을 제공한다. 안쪽 `result.result`는 아래 공통 DTO다.

```json
{
  "riskLevel": "UNKNOWN",
  "textDecision": "phishing",
  "riskScore": 0.82,
  "scoreScale": "0..1",
  "scoreMeaning": "UNCALIBRATED_CLASSIFIER_SCORE",
  "reasons": [],
  "guidance": [],
  "summary": null
}
```

가상 fixture이며 모델의 정확도나 보정된 피싱 확률을 의미하지 않는다.

| 저장 결과 | 외부 type / sourceType | 매핑 |
| --- | --- | --- |
| IMAGE | IMAGE / IMAGE | 공통 riskScore=null. CuRe/TruFor 점수는 모델별로 유지. 성공 모델의 저장 description만 reasons에 포함. 모델 행이 없는 레거시 IMAGE는 기존 reasons 사용 |
| DIRECT TEXT | TEXT / TEXT | 공개 POST의 DIRECT를 AI 내부 TEXT로 매핑한 저장 결과를 사용. GET sourceType=TEXT는 기존 #17 계약을 유지 |
| 문자 캡처 | TEXT / SCREEN_CROP | #15가 저장한 textResult.sourceType을 사용. AI 응답이 없는 진행/실패 기록도 출처 메타데이터로 SCREEN_CROP 유지 |

## 상태와 정책

실제 enum은 QUEUED / ANALYZING / COMPLETED / FAILED이며 PROCESSING으로 변경하지 않는다. QUEUED/ANALYZING/FAILED의 공통 점수·판정·요약은 null, reasons/guidance는 빈 배열이다. #15의 출처 메타데이터는 분석 결과로 해석하지 않는다. COMPLETED에서만 검증 가능한 TEXT 점수·판정을 매핑한다. null/비정상 범위 점수는 null이며 defer는 원본 판정으로 유지한다.

공통 위험 단계 정책이 없어 riskLevel은 UNKNOWN이다. CuRe의 AI 생성 점수나 TruFor의 변조 점수를 피싱 위험도로 환산하거나 합산하지 않는다. TEXT 점수는 0..1 미보정 분류 점수다. TEXT 원문·OCR·자유문구 evidence는 재노출하지 않는다. 프론트는 공통 결과를 표시할 때 result.result를 사용하고 모델별 상세값은 modelResults로 구분한다.

Safety/Guide의 실행 Service·단계별 콘텐츠가 없으므로 guidance=[]다. Gemini 호출 Service도 없으며 기존 summaryStatus=COMPLETED인 저장 요약만 포함한다. 요약 null/PENDING/FAILED는 null이고 원본 분석 상태를 변경하지 않는다. GET은 DB 읽기만 하며 AI/Gemini 호출을 하지 않는다.

Repository는 `id`, `userId`, `expiresAt > now`를 쿼리 조건으로 유지한다. Schema와 migration을 변경하지 않는다. requestHash/idempotencyKey/userId, 원본 이미지·TEXT·OCR·textPreview는 상세 GET에서 제외한다.

## 검증 및 남은 작업

Mapper 단위 검증, 실제 Guard/Controller/Service/Repository와 Mock Prisma의 HTTP 검증, 격리 PostgreSQL의 공개 POST→저장→GET 테스트를 구분한다. 실제 AI 통신은 Mock이며 실추론 성공을 주장하지 않는다. 상세 실행 결과는 분리 보고서에 기록한다.

위험 단계 임계값, Safety 안내, Gemini 실제 생성, 로그인·토큰 발급 기능은 후속 범위다. 실제 OCR 서버의 인증 성공 및 OCR→피싱 모델 동작은 별도 실제 서버 검증이 필요하다. 커밋·푸시 상태와 반영 순서는 분리 보고서의 최신 안내를 참고한다.
