# 이미지 분석 인증 및 전송 정책

POST /api/analysis는 JWT Bearer가 필수이며 JWT sub를 사용자 ID로 저장한다.
NODE_ENV=development와 ANALYSIS_AUTH_BYPASS=true를 함께 설정한 경우에만 토큰 없는 요청을
공용 development-user로 처리한다. 토큰을 보낸 경우에는 개발 환경에서도 검증한다.
운영 환경의 AI_SERVER_BASE_URL은 HTTPS만 허용한다. 인증 정보·query·fragment가 포함된 URL은 거부한다.
서비스 토큰은 AI_SERVICE_TOKEN 환경변수로만 공급한다. 외부 오류 본문과 원본 이미지·토큰은 로그나 오류 응답으로 전달하지 않는다.
리다이렉트 및 자동 재시도는 하지 않는다.
