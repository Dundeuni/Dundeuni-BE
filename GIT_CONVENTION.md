# 든든이 백엔드 협업 규칙

## 1. 기본 원칙

- 모든 작업은 이슈를 만든 뒤 작업 브랜치와 PR로 반영한다.
- `main`과 `dev`에 직접 push하지 않는다.
- 구현 전 API·DB·연동 영향 범위를 이슈와 PR에서 공유한다.
- AI 분석 결과는 확정 판정이 아닌 위험 가능성, 근거, 대응 방법으로 표현한다.
- 원본 이미지·텍스트 등 민감 데이터는 최소 수집하며, 저장·공유는 사용자 동의와 보관 정책을 명시한 경우에만 한다.

## 2. 브랜치 전략

```text
main                 배포·데모 기준 브랜치
dev                  개발 통합 브랜치
feature/<issue>-...  기능 개발
fix/<issue>-...      버그 수정
refactor/<issue>-... 리팩터링
docs/<issue>-...     문서 작업
chore/<issue>-...    설정·환경 작업
```

- 일반 작업 브랜치는 `dev`에서 만들고 `dev`로 PR을 연다.
- 배포 또는 데모 준비 PR만 `dev`에서 `main`으로 연다.
- 브랜치 이름의 `<issue>`는 GitHub 이슈 번호를 사용한다. 예: `feature/12-image-analysis-request`

## 3. 이슈와 라벨

- 시작 전에 목적, 완료 기준, API·DB 영향과 우선순위를 작성한다.
- 라벨은 `작업 유형 + 도메인 + 우선순위` 조합을 권장한다.
- 막힌 작업은 `🚧 blocked`, 리뷰 요청 PR은 `👀 need review`를 붙인다.
- 템플릿은 `.github/ISSUE_TEMPLATE` 및 `.github/PULL_REQUEST_TEMPLATE.md`를 사용한다.

## 4. 커밋 메시지

다음 형식을 사용한다.

```text
<type>: <작업 내용>
```

```text
feat: 이미지 분석 요청 API 추가
fix: URL 검사 결과의 위험 단계 변환 수정
docs: 분석 API 명세 보완
refactor: 공통 예외 응답 구조 분리
test: 인증 서비스 단위 테스트 추가
chore: Docker 개발 환경 설정
```

한 커밋에는 하나의 의도를 담고, 비밀값·개인정보·원본 검사 데이터는 커밋하지 않는다.

## 5. PR과 리뷰

- PR 제목은 커밋과 같은 접두어를 쓴다. 예: `feat: 텍스트 분석 요청 API 추가`
- PR 본문에는 관련 이슈, 변경 API·DB, 검증 결과, Android·AI 서버 영향 여부를 작성한다.
- 최소 1명의 승인 후 Squash merge한다. 작성자는 직접 merge하지 않는 것을 원칙으로 한다.
- 리뷰 요청은 동작 정확성, 예외 처리, 보안·개인정보, API 계약, migration 안전성을 우선 확인한다.
- 리뷰 반영 후에는 변경 사항과 재확인 방법을 PR에 남긴다.

## 6. API와 DB 규칙

- API 변경 시 Swagger와 `docs/api` 문서를 같은 PR에서 갱신한다.
- 요청·응답 DTO에 검증 규칙을 두고, 오류 응답과 예시를 명세한다.
- DB 변경은 Prisma schema와 migration을 함께 커밋한다. migration 파일을 수정하거나 삭제하지 않는다.
- 기존 데이터 영향, NULL·기본값·UNIQUE·FK 변경은 PR에 별도로 기록한다.
- AI 서버와 Android 사이의 요청·응답 계약 변경은 양쪽 담당자에게 공유한 뒤 반영한다.

## 7. 병합 전 확인

- [ ] 이슈·라벨·PR 템플릿 작성
- [ ] lint, test 및 필요한 로컬 API 확인
- [ ] Swagger와 `docs/api` 반영
- [ ] Prisma migration 및 기존 데이터 영향 확인
- [ ] 환경변수·Secret·개인정보 노출 여부 확인
- [ ] Android·AI 서버 연동 계약 영향 공유
