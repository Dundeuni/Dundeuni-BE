# Auth/User API

구현 전 이 문서에 인증 방식, 요청·응답 DTO, 오류 응답을 확정합니다.

## Analysis용 최소 Access Token 검증

현재 로그인/토큰 발급은 미구현이다. Analysis API는 Common의 AccessTokenGuard를 사용한다.
`Authorization: Bearer {token}`을 받아 `JWT_ACCESS_SECRET`으로 HS256 서명을 검증한다.
`sub`는 비어 있지 않은 사용자 식별 문자열, `exp`는 유효한 미래 만료 시각이어야 한다.
`nbf`가 있으면 활성 시각도 검증한다. 누락/위조/만료 시 `401 / AUTH401`이다.
기본 예시 secret 또는 secret 미설정은 `500 / COMMON500`으로 거부한다.

TODO: Auth 구현 시 토큰 발급 계약(알고리즘, issuer, audience), 사용자 존재/비활성 여부 및 User FK 연결 확정.
현재 JWT 검증만으로 사용자를 식별하며, DB 사용자 조회나 Refresh Token 기능은 제공하지 않는다.
