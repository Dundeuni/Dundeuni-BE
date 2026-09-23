# Dundeuni Backend

스마트폰 사용 중 발견한 의심 이미지·문자·URL을 검사하고, AI 생성·변조 가능성과 사기 위험을 별도로 분석해 대응 방법을 제공하는 디지털 안전 서비스 **든든이**의 백엔드입니다.

```text
의심 콘텐츠 발견 → 플로팅 버튼 실행 → 입력 수집·분류 → 분석 요청
→ AI 생성·변조 가능성 + 사기 위험 분석 → 근거·대응 방법 제공
```

## 기본 구조

```text
src/
├── common/             공통 응답, 예외, 인증 기반, Health check
├── config/             환경별 설정
├── domains/
│   ├── auth/           인증·사용자
│   ├── analysis/       이미지·텍스트·URL 검사와 AI 서버 연동
│   ├── family/         가족 연결·위험 결과 공유
│   ├── safety-guide/   대응 방법·신고·상담 기관 안내
│   ├── notification/   위험·분석 결과 알림
│   └── quiz/           AI·피싱 판별 학습
└── prisma/             Prisma client와 database module
docs/api/               Swagger 미러 API 문서
.github/                이슈, PR 템플릿과 라벨 정의
```

## 기술 스택

- NestJS, TypeScript, PostgreSQL, Prisma
- JWT Access/Refresh Token, OAuth2
- Swagger, class-validator / class-transformer
- REST 기반 AI 서버 연동, FCM, S3 호환 Object Storage
- Docker / Docker Compose

Redis/BullMQ는 분석 요청의 비동기 처리가 실제로 필요해질 때 도입을 검토합니다.

## 시작하기

```bash
npm install
cp .env.example .env
npm run start:dev
```

- Health check: `GET http://localhost:3000/api/health`
- Swagger: `http://localhost:3000/api/docs`

Prisma schema와 migration은 DB 모델을 확정하는 이슈에서 추가합니다.

## 협업

- 협업 규칙: [GIT_CONVENTION.md](./GIT_CONVENTION.md)
- 라벨 가이드: [.github/LABELS_GUIDE.md](./.github/LABELS_GUIDE.md)
- API 문서: [docs/api](./docs/api/README.md)

```text
main: 배포·데모 기준
dev: 개발 통합
feature/*, fix/*, chore/*, docs/*, refactor/*: dev를 대상으로 PR
```

## MVP 범위

P0은 회원가입·로그인, 사용자 프로필, 이미지·텍스트·URL 검사, 분석 결과·기록 조회, 위험 단계와 판단 근거, 상황별 대응 가이드입니다.

전화번호·QR 검사, 가족 연결·공유, FCM 알림과 퀴즈는 P1이며, 영상·통화 분석은 후속 확장 범위입니다.
