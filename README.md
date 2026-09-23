# Dundeuni Backend

스마트폰 사용 중 마주치는 의심스러운 사진·영상·문자·링크·전화 등을
**플로팅 버튼 한 번으로 검사하고, AI 생성·변조 여부와 사기 위험성을 함께 분석해 대응 방법까지 제공하는 디지털 안전 서비스 「든든이」의 백엔드**.

```text
의심 콘텐츠 발견
→ 플로팅 버튼 실행
→ 검사 대상 선택/수집
→ 분석 요청
→ AI 생성·변조 여부 + 사기 위험 분석
→ 안전 / 주의 / 위험 결과 제공
→ 판단 근거 확인
→ 신고·상담·가족 공유 등 후속 대응
```

## Repository 구성

GitHub Organization은 `Deundeuni`를 기준으로 구성한다.

```text
Deundeuni
├── deundeuni-android
├── deundeuni-server
└── deundeuni-ai
```

* `deundeuni-android`: Android 앱 및 플로팅 버튼, 사용자 화면
* `deundeuni-server`: 인증, 사용자, 분석 요청/결과, 가족 연결, 알림 등 백엔드
* `deundeuni-ai`: AI 생성·변조 및 사기 위험 분석 모델/추론 서버

---

## 도메인 구성

| 도메인          | 주요 책임                                  |
| ------------ | -------------------------------------- |
| Auth/User    | 회원가입, 로그인, 소셜 로그인, 사용자 프로필, 서비스 설정     |
| Analysis     | 검사 요청, 검사 유형 관리, AI 서버 연동, 분석 결과 저장·조회 |
| Family       | 가족 연결, 연결 요청/승인, 위험 상황 가족 공유           |
| Safety/Guide | 위험 상황별 대응 방법, 신고·상담 기관 안내              |
| Notification | 가족 위험 알림, 분석 관련 Push 알림                |
| Quiz         | AI 콘텐츠·피싱 판별 퀴즈, 사용자 학습 기록             |

### Analysis 도메인

든든이의 핵심 도메인이다.

분석 대상은 하나의 `Analysis` 흐름으로 관리하고, 검사 유형을 구분한다.

```text
IMAGE
VIDEO
TEXT
URL
PHONE
QR
```

백엔드는 AI 모델 자체를 구현하지 않고 다음 역할을 담당한다.

```text
Android
   ↓
Deundeuni Server
   ↓
검사 요청 검증
   ↓
AI Server 호출
   ↓
AI 분석 결과 수신
   ↓
결과 형식 통일 / 후처리
   ↓
DB 저장
   ↓
Android 응답
```

AI 분석 결과는 가능한 한 공통 구조로 반환한다.

```text
위험 단계
→ SAFE / CAUTION / DANGER

분석 결과
→ AI 생성·변조 가능성
→ 사기 위험 가능성

판단 근거
→ 어떤 요소 때문에 해당 결과가 나왔는지

대응 방법
→ 무시 / 차단 / 신고 / 상담 / 가족 공유 등
```

> AI 결과는 확정적인 판정이 아니라 **위험 가능성과 판단 근거를 제공하는 방식**을 기본 원칙으로 한다.

---

## MVP 데이터 범위

1차 MVP에서는 모든 기능을 한 번에 구현하기보다 실제 시연이 가능한 핵심 검사 흐름을 우선한다.

### P0

* 회원가입 / 로그인
* 사용자 기본 프로필
* 이미지 검사
* 문자·텍스트 검사
* URL 검사
* 분석 결과 조회
* 분석 기록 조회
* 안전 / 주의 / 위험 단계 표시
* 분석 근거 제공
* 상황별 대응 가이드

### P1

* 전화번호 위험 검사
* QR 검사
* 가족 연결
* 위험 결과 가족 공유
* FCM Push 알림
* AI 콘텐츠·피싱 판별 퀴즈

### 추후 확장

* 영상 분석
* 통화 상황 분석
* 가족 위험 자동 알림
* 사용자 신고 데이터 활용
* 새로운 사기 유형 데이터 지속 반영

---

## 기술 스택

* Framework: NestJS
* Language/Runtime: TypeScript + Node.js
* Database: PostgreSQL
* ORM: Prisma
* Auth: JWT Access/Refresh Token + OAuth2
* Validation: class-validator / class-transformer
* API Docs: Swagger + Notion API 명세 + `docs/api` 미러 문서
* AI Integration: REST API 기반 AI Server 연동
* Push: FCM
* Media Storage: 이미지·영상 업로드가 필요한 경우 S3 계열 Object Storage 사용 예정
* Container: Docker / Docker Compose

> 초기 MVP에서는 불필요한 인프라를 먼저 추가하지 않는다.
> 영상 분석 등 비동기 처리가 실제로 필요해지는 시점에 Redis/BullMQ 등의 Queue 도입을 검토한다.

---

## 로컬 실행

```bash
# 1. 의존성 설치
npm install

# 2. 환경변수 설정
cp .env.example .env

# 3. Prisma Client 생성
npx prisma generate

# 4. Migration
npx prisma migrate dev

# 5. 서버 실행
npm run start:dev
```

기본 실행 환경

```text
API
http://localhost:3000

Health Check
GET http://localhost:3000/api/health

Swagger
http://localhost:3000/api/docs
```

---

## Docker 실행

로컬 개발환경 차이를 줄이기 위해 Docker Compose로 API와 PostgreSQL을 동일한 환경에서 실행할 수 있도록 구성한다.

```bash
cp .env.example .env

docker compose up --build
```

구성

```text
PostgreSQL 실행
→ DB Health Check
→ Prisma Migration
→ NestJS API 실행
```

종료

```bash
docker compose down
```

---

## 환경변수

`.env.example`에는 실제 Secret을 포함하지 않는다.

예시:

```env
NODE_ENV=development
PORT=3000

DATABASE_URL=

JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=

AI_SERVER_URL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

FCM_PROJECT_ID=
```

실제 Secret 값이 포함된 `.env`는 Git에 업로드하지 않는다.

---

## API 문서

API 명세는 다음 순서로 관리한다.

```text
Notion API 명세
        ↓
구현
        ↓
Swagger
        ↓
GitHub docs/api
```

### SSOT

**Notion API 명세서를 기준 문서로 사용한다.**

GitHub에서는 다음과 같이 미러 문서를 관리한다.

```text
docs/
└── api/
    ├── README.md
    ├── auth-user.md
    ├── analysis.md
    ├── family.md
    ├── safety-guide.md
    ├── notification.md
    └── quiz.md
```

API 변경 PR에서는

```text
Notion API 명세
Swagger
docs/api
```

세 문서의 내용이 일치하는지 확인한다.

---

## 로컬 DB 개발 원칙

* 1차 개발은 각자 로컬 PostgreSQL을 사용한다.
* DB Schema 변경은 Prisma Schema와 Migration으로 관리한다.
* `.env`의 `DATABASE_URL`은 개인 로컬 DB 주소를 사용한다.
* DB 구조 변경 시 `schema.prisma`만 수정하고 끝내지 않고 Migration을 반드시 생성한다.
* DataGrip은 DB 테이블/데이터 확인용으로 사용한다.
* Postman/Swagger는 API 요청·응답 테스트용으로 사용한다.
* Android 연동이 시작되면 공유 Dev Server와 Dev DB를 별도로 구성한다.
* 운영 DB를 로컬 테스트 목적으로 직접 수정하지 않는다.

---

## AI 협업 원칙

AI팀과 Backend팀 사이의 요청/응답 형식을 사전에 고정한다.

예시:

```text
POST /inference/image
POST /inference/text
POST /inference/url
```

AI Server의 응답 예시:

```json
{
  "riskScore": 0.87,
  "riskLevel": "DANGER",
  "aiGeneratedProbability": 0.76,
  "scamProbability": 0.91,
  "reasons": [
    "금전 송금을 요구하는 표현이 포함되어 있습니다.",
    "의심스러운 URL 패턴이 탐지되었습니다."
  ]
}
```

Backend에서는 AI Server의 원본 결과를 Android에 그대로 전달하지 않고, 서비스 규격에 맞게 가공한다.

```text
AI Model Output
↓
Backend 후처리
↓
든든이 공통 Analysis Response
↓
Android
```

이를 통해 AI 모델이 변경되더라도 Android API 구조는 최대한 유지한다.

---

## 개인정보 처리 원칙

든든이는 문자, 이미지, 전화번호 등 민감할 수 있는 정보를 다루므로 다음 원칙을 따른다.

* 분석에 필요한 최소 정보만 서버로 전달
* 주민등록번호, 계좌번호 등 민감정보 마스킹
* 분석용 원본 파일의 불필요한 장기 저장 금지
* 분석 후 원본 파일 삭제 정책 정의
* 분석 결과와 원본 데이터의 저장 범위 분리
* 가족 공유는 사용자 동의가 있는 경우에만 수행
* 로그에 Access Token, 개인정보, 원문 문자 등을 그대로 남기지 않음

---

## 협업 규칙

* 브랜치 전략, Commit Convention, PR 규칙: `GIT_CONVENTION.md`
* 라벨 가이드: `.github/LABELS_GUIDE.md`
* Issue Template / PR Template: `.github/`
* API 명세: Notion 우선 확인
* GitHub API 미러: `docs/api`
* `main`, `dev` Branch Protection 적용
* 작업 브랜치는 PR을 통해서만 반영
* 최소 1명 Review 승인 후 Merge
* 기본 Merge 방식은 Squash Merge

---

## 브랜치

```text
main
최종 배포 / 발표 / Release 기준

dev
개발 통합 브랜치
PR 기본 대상

feature/*
새로운 기능

fix/*
버그 수정

refactor/*
리팩터링

chore/*
환경설정 / 의존성 / 기타 작업

docs/*
문서 작업

test/*
테스트 코드
```

예시:

```text
feature/auth-login
feature/analysis-image
feature/family-connect
fix/analysis-result
docs/api-analysis
```

---

## Git Flow

```text
Issue 생성
↓
작업 Branch 생성
↓
개발
↓
Local Test
↓
dev 대상 PR
↓
Code Review
↓
Squash Merge
↓
Branch 삭제
```

`main`에는 직접 Push하지 않는다.

```text
feature/* → dev → main
```

개발 중에는 `dev`를 기준으로 기능을 통합하고,
시연 또는 Release가 가능한 시점에 `dev → main` PR을 생성한다.

---

## DB 변경 규칙

DB Schema를 수정하는 경우 반드시 다음 내용을 PR에 포함한다.

```text
1. 변경 이유
2. 변경된 Prisma Schema
3. 생성된 Migration
4. 기존 API 영향 여부
5. Android / AI 영향 여부
```

Migration 예시:

```bash
npx prisma migrate dev --name add_analysis
```

Migration 파일을 임의로 삭제하거나 다른 팀원의 Migration을 수정하지 않는다.

---

## API 변경 규칙

기존 API를 변경할 경우 해당 API를 사용하는 파트와 먼저 공유한다.

특히 아래 변경은 반드시 공유한다.

```text
Endpoint 변경
Request Body 변경
Response 변경
Enum 변경
필수/선택 Parameter 변경
Error Code 변경
```

Backend 단독 판단으로 기존 Response Field를 삭제하거나 이름을 변경하지 않는다.

---

## 1차 구현 범위

| 도메인          | 1차 우선 구현 API                                                  |
| ------------ | ------------------------------------------------------------- |
| Health       | `GET /health`                                                 |
| Auth/User    | `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh` |
| User         | `GET /users/me`, `PUT /users/me`                              |
| Analysis     | `POST /analyses`, `GET /analyses/{analysisId}`                |
| Analysis     | `GET /users/me/analyses`                                      |
| Safety/Guide | `GET /safety-guides`                                          |

분석 요청은 검사 종류를 통해 구분하는 방식을 우선 검토한다.

예시:

```http
POST /analyses
```

```json
{
  "type": "TEXT",
  "content": "국민은행입니다. 지금 즉시..."
}
```

또는 파일 분석의 경우

```http
POST /analyses
Content-Type: multipart/form-data
```

```text
type = IMAGE
file = image.jpg
```

향후 API 명세 단계에서 Android 및 AI팀과 논의 후 최종 Endpoint를 확정한다.

---

## 개발 우선순위

```text
1. 프로젝트 초기 세팅
2. Health Check
3. Swagger
4. Prisma / PostgreSQL 연결
5. Auth
6. User
7. Analysis 기본 구조
8. AI Server Mock 연동
9. 실제 AI Server 연동
10. 분석 결과 저장 / 조회
11. Android 연동
12. Family / Notification
13. Quiz / Guide
14. 예외처리 / 테스트 / 배포
```

핵심 개발 흐름은 다음과 같다.

```text
Android
→ Backend
→ AI
→ Backend
→ Android
```

따라서 **AI가 완성될 때까지 Backend 개발을 기다리지 않고**, AI팀과 먼저 Request/Response 규격을 정한 뒤 Mock Response를 사용하여 Backend와 Android 개발을 병렬로 진행한다.
