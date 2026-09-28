# Railway 배포·운영 설정

이 문서는 `Dundeuni-BE` Railway 서비스의 운영 설정 기준이다. Secret의 실제 값은 저장소에 기록하거나 커밋하지 않는다.

## 저장소 기준 설정

`railway.json`은 다음 값을 버전 관리한다.

- Healthcheck path: `/api/health`
- Healthcheck timeout: `300`초

Nest 애플리케이션은 Railway가 주입하는 `PORT`를 사용하며, `GET /api/health`는 `200 OK`와 `{ "status": "ok" }`를 반환한다.

## Railway Variables

`Dundeuni-BE` 서비스의 `production` 환경에서 아래 값을 설정한다.

| 변수 | 값 또는 설정 방식 | 비고 |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Postgres 서비스 Reference를 사용한다. 실제 접속 문자열을 직접 복사하지 않는다. |
| `JWT_ACCESS_SECRET` | Railway Secret | 충분히 긴 무작위 값 |
| `JWT_REFRESH_SECRET` | Railway Secret | access secret과 다른 무작위 값 |
| `AI_API_URL` | AI 서버의 base URL | 외부 AI 서비스 연동 시 사용 |
| `OPENAPI_SERVICE_KEY` | Railway Secret | Phone OpenAPI 키 |
| `NODE_ENV` | `production` | 운영 환경 식별 |

애플리케이션 코드에서 아직 사용하지 않는 변수도 Railway에는 미리 등록할 수 있지만, 실제 AI·OpenAPI 연동 구현 때 변수명과 사용 위치를 함께 확정한다.

## Prisma migration

현재 저장소에는 `prisma/schema.prisma`, Prisma CLI 의존성, committed migration이 없다. 따라서 아직 **Pre-deploy Command를 설정하지 않는다**. 이 상태에서 `npx prisma migrate deploy`를 설정하면 schema를 찾지 못해 배포가 실패한다.

Prisma를 도입하는 별도 DB 이슈에서 다음을 함께 완료한 뒤 Railway `Settings → Deploy → Pre-deploy Command`에 아래 명령을 설정한다.

```text
npx prisma migrate deploy
```

- `prisma`를 배포 이미지에 포함되는 의존성으로 추가
- `prisma/schema.prisma` 추가 및 `DATABASE_URL` 참조
- migration 파일 생성·커밋
- 스테이징 또는 빈 DB에서 migration 성공 확인

Pre-deploy 명령은 애플리케이션 시작 전 별도 컨테이너에서 실행되며, 실패하면 배포도 중단된다. timeout은 우선 300초로 설정하고, 실제 migration 시간에 맞게 조정한다.

## GitHub 자동배포

`Dundeuni-BE` 서비스의 소스는 GitHub repository와 `main` 브랜치를 연결한다. `Auto deploy unavailable` 또는 `Could not load branches`가 보이면 다음 순서로 확인한다.

1. Railway 프로젝트의 GitHub integration에서 `Dundeuni/Dundeuni-BE` repository 권한을 다시 부여한다.
2. 서비스 `Settings → Source`에서 repository를 다시 선택하고 배포 브랜치를 `main`으로 저장한다.
3. Railway에서 `main` 브랜치를 읽을 수 있는지 확인한 뒤, 빈 커밋 대신 이 설정 변경을 포함한 정상 커밋으로 자동배포를 검증한다.

일반 개발 작업은 `chore/*`, `feature/*` 브랜치에서 진행해 `dev`로 PR을 열고, 배포·데모 준비 시에만 `dev`에서 `main`으로 병합한다.

## 환경 전략

현재는 팀 내부 테스트를 `production` 환경 하나로 운영한다. 데이터·외부 API 키·테스트 안정성을 분리해야 하는 시점에 `staging`을 만들고, Postgres도 별도 서비스 또는 별도 데이터베이스로 분리한다. `production`의 `DATABASE_URL`이나 Secret을 `staging`에 공유하지 않는다.
