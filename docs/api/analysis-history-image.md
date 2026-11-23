# IMAGE/SCREEN 검사 기록의 저장 Gemini 요약

## 범위와 의존성

관련 이슈: [#26 IMAGE/SCREEN 검사 기록](https://github.com/Dundeuni/Dundeuni-BE/issues/26).

- 브랜치 `feature/26-history-image`는 `origin/dev`의 `b3ce599`에서 생성했다.
- 공통 기록 API PR #29의 `feature/25-history-base` 커밋 `ae77a31`은 아직 dev에 없다.
  공통 API를 중복 생성하지 않고 그 변경을 **미커밋 로컬 패치**로 적용했다.
  재현용 Base 패치는 `/private/tmp/history-image-base-dependency.patch`에 있으며 Base 브랜치는 변경하지 않았다.
- dev에는 Analysis의 요약 필드와 `AnalysisRepository.saveSummary()`만 있고, Gemini Worker/Client는 없다.
  Gemini 생성·큐·재시도는 선행 PR #9의 별도 구현이다. 이를 가져오거나 새 생성 서비스를 중복 구현하지 않았다.
  실제 Gemini 생성 후 자동 저장은 #9 통합 후 생성 경로에서 검증해야 한다.
- 현재 SCREEN은 AnalysisType Enum에 없으며 POST에서 지원하지 않는다. SCREEN Enum/migration을 추가하지 않는다.
  캡처 이미지를 IMAGE로 분석·저장하면 같은 요약 조회 경로를 사용한다.
  추후 SCREEN 저장 유형이 도입되면 공통 projection을 그대로 사용할 수 있지만 현재 SCREEN 저장 기능이 있다고 간주하지 않는다.

## 저장

기존 Analysis 행의 `id`, `type`, `aiRiskLevel`, `aiGenerationScore`, `createdAt`, `completedAt`을 재사용한다.
Gemini 생성 결과를 받는 쓰기 경로는 기존 `AnalysisRepository.saveSummary(analysisId, result)`를 사용한다.

- `PENDING`: summary/model/time은 null
- `COMPLETED`: summary, summaryModel, summarizedAt 저장
- `FAILED`: summary/model/time은 null, summaryStatus=FAILED

요약 실패는 분석 상태·점수·위험도·검사 시각·모델 결과를 수정하거나 분석 행을 삭제하지 않는다.
실제 DB 테스트에서 이 저장 함수의 상태 전이 및 기존 결과 보존을 검증한다.
이 브랜치는 아직 없는 Gemini 생성기를 호출하거나 가짜 요약을 만들지 않는다.

기존 dev의 IMAGE POST는 공용 development-user로 저장했으므로, 기존 AccessTokenGuard를 적용하고
JWT sub로 저장하도록 변경했다. 이제 POST도 개발 환경을 포함해 JWT가 필수다.
이는 생성한 사용자가 자신의 검사 기록을 다시 조회할 수 있도록 소유자를 일치시키기 위한 변경이다.

## 조회

새 URL은 추가하지 않고 공통 API를 확장한다.

### GET /api/analysis/history

IMAGE의 targetSummary는 **COMPLETED 상태로 DB에 저장된 summary 원문**이다.
PENDING/FAILED/null, 빈 요약이면 targetSummary=null이다. 사용자 소유권·만료 조건은 공통 Repository를 재사용한다.
최종 위험 단계는 저장된 aiRiskLevel을 그대로 반환하며 임의로 SAFE/LOW 등을 추론하지 않는다.

### GET /api/analysis/history/:analysisId

공통 필드의 aiGenerationScore, aiRiskLevel, createdAt, completedAt을 유지하고 다음 detail을 제공한다.

```json
{
  "summary": "이미 DB에 저장된 Gemini 요약본입니다.",
  "summaryStatus": "COMPLETED",
  "summaryModel": "gemini-stored-model",
  "summarizedAt": "2026-11-21T10:00:00.000Z"
}
```

미완료 상태는 다음과 같다. 상태는 DB 값 그대로이며 자동 복구·생성·재시도를 하지 않는다. `COMPLETED`라도 요약 문자열이 `null`·빈 문자열·공백뿐이면 `summary`, `summaryModel`, `summarizedAt`은 모두 `null`로 반환한다.

```json
{"summary":null,"summaryStatus":"PENDING","summaryModel":null,"summarizedAt":null}
```

FAILED도 동일한 nullable 필드와 FAILED 상태를 반환한다. 미생성은 summaryStatus=null이다.
상태와 불일치하는 오래된 요약·모델·시각이 DB에 남아 있어도 PENDING/FAILED/null에서는 노출하지 않는다.
다른 분석 유형의 detail은 기존 공통 계약대로 null이며 IMAGE 요약으로 해석하지 않는다.

IMAGE와 향후 SCREEN은 `ImageHistorySummaryService`의 동일한 필드 projection을 사용한다.
이 서비스에는 Gemini Client·Worker·Queue·Config 의존성이 없다. 조회와 반복 조회는 DB 읽기만 수행한다.
Repository는 필요한 요약 필드만 명시적으로 선택하고 원본 이미지·파일·이미지 URL·요청 해시·API 키·프롬프트를 반환하지 않는다.

## 테스트와 미검증 범위

- JWT IMAGE POST → 실제 PostgreSQL 저장 → 기존 saveSummary(PENDING/COMPLETED) → 목록·상세 재조회
- 저장된 요약·모델·시각·점수·위험도 일치, 반복 조회 시 fetch/이미지 Provider 추가 호출 없음
- 요약 실패 후 분석·모델 결과·시각 보존
- 미생성/PENDING/FAILED 및 완료 상태의 빈 요약 처리
- 다른 사용자·만료 기록 접근 차단과 기존 공통 기록/IMAGE 회귀
- 명시적 응답 projection으로 원본·URL·키·프롬프트 필드 비노출, Swagger DTO 검증
- SCREEN은 shared projection만 단위 검증한다. 실제 SCREEN 저장은 현재 구현이 없어 미검증이다.
- 실제 Gemini 서버/SDK의 생성 완료·실패를 자동 저장하는 end-to-end는 생성 기능 #9 통합 후 필요하다.
  테스트는 실제 Gemini API를 호출하지 않으며 실제 서버 검증을 완료했다고 주장하지 않는다.

격리된 로컬 history_test_<숫자> DB에 dev migration을 적용한 뒤:

```bash
HISTORY_DB_URL=postgresql://test_user@127.0.0.1:55440/history_test_20261121 \
V1_DB_TEST=1 V1_DB_URL=postgresql://test_user@127.0.0.1:55440/history_test_20261121 \
npm run test:e2e -- --runInBand
```

별도 보관 정책 작업으로 만료 기록 자동 삭제와 신규 IMAGE의 최대 30일 보관이 같은 브랜치에 포함되어 있다. 이 변경은 #26의 핵심 조회 기능과 별개이므로 후속 통합 시 독립 검토가 필요하다. 만료 정리용 expiresAt/id 인덱스 migration이 추가되었으며 컬럼·Enum 변경은 없다. 자세한 내용은 `analysis-expiry.md`를 참고한다. 이 브랜치의 후속 수정은 개별 커밋으로 반영되었으며, dev/main 머지는 수행하지 않았다.
