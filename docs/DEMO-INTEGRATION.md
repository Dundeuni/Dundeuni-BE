# FE 통합 시연

브랜치: `demo/all-features`, worktree: `.worktrees/demo-integration`.
기존 서버는 3000, 통합 서버는 3001을 사용한다. FE API base를 `http://localhost:3001/api`로 지정한다.

```sh
npm install
npm run prisma:generate
npm run prisma:migrate
npm run start:dev
```

`.env`에 `NODE_ENV=development`, `PORT=3001`, FE origin을 쉼표로 나열한 `CORS_ORIGINS`를 설정한다. 개발 모드에서는 모든 API가 `development-user`를 공유한다. 실사용자 정보 대신 시연 데이터를 사용한다.
이미지는 기존 AI_PROVIDER/AI_SERVER_BASE_URL/AI_SERVICE_TOKEN, 텍스트는 TEXT_AI_PROVIDER=http/AI_SERVICE_BASE_URL/TEXT_AI_SERVICE_TOKEN, 전화번호는 APICK_AUTH_KEY, 사진 요소는 GEMINI_API_KEY/GEMINI_MODEL을 사용한다.

| 기능 | 요청 |
| --- | --- |
| 이미지 분석 | `POST /analysis`, multipart `type=IMAGE`, `file` |
| 텍스트 분석 | `POST /analysis`, JSON `{"type":"TEXT","text":"택배 배송 주소를 확인해주세요 https://example.com"}` |
| 문자 캡처 OCR | `POST /analysis`, multipart `type=TEXT`, `sourceType=SCREEN_CROP`, `file` |
| 전화번호 피싱 조회 | `POST /analyses/phone`, JSON `{"phoneNumber":"시연용 번호"}` |
| 기록 목록 | `GET /history?limit=20` |
| 통합 기록 상세 | `GET /history/{analysisId}` |
| 기존 분석 상세 | `GET /analysis/{analysisId}` |
| 이미지 요약 | `GET /analysis/{analysisId}/summary` |
| 이미지 요소 추출 | `POST /analysis/image-uploads`, multipart `file` |
| 선택 요소 분석 | `POST /analysis/image-uploads/{uploadId}/analyses`, JSON `{"elementId":"선택한 UUID"}` |
| 요소 업로드 취소 | `DELETE /analysis/image-uploads/{uploadId}` |

사진 후보 추출 후 사용자 선택을 거쳐 분석한다. `original.elementId`는 전체 이미지 선택이다. 추출만으로 이미지 분석을 자동 호출하지 않는다.
목록의 `items[].id`를 상세 조회의 analysisId로 사용한다. 전화번호 응답은 기존 계약대로 최상위 analysisId/status이며 나머지 API의 result 래퍼와 다르다.

FE에서 독립된 기능을 함께 실행하려면 `Promise.allSettled`로 각 요청 결과를 표시하고, 끝난 뒤 `/history`를 새로 조회한다. 요소 분석은 후보 선택이 필요하므로 추출 이후 별도로 호출한다. 이미지 파일은 요청마다 새 FormData를 만들어 전달한다.
Swagger: http://localhost:3001/api/docs

## FE 한 번에 호출 예시

`examples/demo-client.mjs`를 FE 프로젝트로 복사해 사용한다.

```js
import { createDemoClient } from './demo-client.mjs';
const api = createDemoClient('http://localhost:3001/api');
const results = await api.runDemo({ image: selectedFile, text: inputText, phoneNumber: inputPhone });
// results.image / text / phone / elements / history: PromiseSettledResult
// elements.value.result의 후보 중 사용자가 선택한 뒤:
await api.select(uploadId, elementId);
const history = await api.history();
```

## 실행 검증

2026-11-11: TypeScript 검사·빌드 통과. 기존 회귀 테스트 390개 및 기록 API 테스트 6개 통과(선택적 DB/live 테스트 75개 제외).
실제 외부 연동: 비민감 패턴 이미지 분석 202, 가상 번호 APICK 조회 201, 사진 후보 추출 201(패턴 이미지이므로 후보 0), 기록 목록 200, CORS preflight 204.
텍스트 분석은 현재 설정된 ngrok 서버가 오프라인(ERR_NGROK_3200)이어서 503. 실행 중인 AI_SERVICE_BASE_URL로 갱신 후 서버를 재시작해야 한다. mock 성공으로 대체하지 않는다.
