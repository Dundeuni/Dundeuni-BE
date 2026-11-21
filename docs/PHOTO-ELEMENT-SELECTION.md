# 사진 영역 추출·선택 분석 (Issue #23)

## 범위

BE가 스크린샷의 사진 영역 후보를 추출하고 사용자가 선택한 원본 전체 또는 사진 영역 한 개만 기존 CuRe/FUSED 분석 및 요약 경로로 보낸다. 기존 POST /api/analysis는 전체 이미지 즉시 분석으로 유지한다. OCR은 실행하지 않는다.

탐지는 `gemini-photo-regions-v1`이다. BE가 캡처의 축소 미리보기를 Gemini 비전 API로 전송해 사진 패널 좌표를 인식한 뒤, 원본 해상도의 정규화 이미지에서 crop한다. 사람/사물/얼굴의 박스가 아닌 사진 전체 패널을 찾는다. 콜라주는 사진별로 분리하며 UI, 텍스트, 로고, 프로필 아이콘, 화면 가장자리의 작게 잘린 추천 이미지를 제외하도록 지시한다. 사진이 없으면 빈 후보를 반환한다.

캡처 이미지가 Google로 외부 전송되므로 제품의 개인정보 안내 및 동의 흐름에 반영해야 한다. 모델의 좌표에는 오차·누락·오검출이 가능하므로 사용자 선택으로 확인하며 자동 판단을 확정 정보로 취급하지 않는다. API 실패 시 구분선/질감 처리나 전체 이미지 후보로 대체하지 않고 PHOTO_DETECTION503을 반환한다.

## 실행 준비

1. `npm run prisma:generate`
2. 대상 DB를 확인한 후 `npm run prisma:migrate` 실행. migration은 `analysis_requests.photoSelection JSONB`만 추가하며 기존 기록은 null이다.
3. GEMINI_API_KEY와 PHOTO_DETECTION_MODEL(미설정 시 GEMINI_MODEL), PHOTO_DETECTION_TIMEOUT_MS(기본 60000, 최대 120000) 설정. 요청당 1회 호출하며 SDK 자동 재시도는 하지 않는다.
4. BE 재시작. 개발용 인증 우회는 `NODE_ENV=development`에서만 적용된다. 그 외 새 API는 기존 JWT Bearer guard를 사용한다.

이 변경은 현재 개발용 상세 조회 인증 정책 자체를 바꾸지 않는다. 실제 사용자별 운영 배포 전 기존 POST/GET/summary에도 동일 인증 정책을 통합해야 한다. development-user는 모든 개발 세션이 공유하므로 실제 개인정보로 테스트하지 않는다.

## API

### 1. POST /api/analysis/image-uploads

multipart/form-data의 file만 전송한다. JPEG/PNG, 최대 10 MiB 및 ANALYSIS_MAX_FILE_BYTES 중 작은 값, 32~8192px, 최대 16,000,000px, 단일 프레임. 실제 디코딩·EXIF 방향 정규화 후 후보를 탐지한다. Gemini 비전으로 사진 영역만 탐지한다. CuRe/FUSED와 결과 요약은 선택 후에만 호출한다.

HTTP 201:

```json
{
  "isSuccess": true,
  "code": "IMAGE_UPLOAD201",
  "message": "사진 후보 추출이 완료되었습니다.",
  "result": {
    "uploadId": "UUID",
    "status": "AWAITING_SELECTION",
    "image": { "width": 400, "height": 800, "coordinateSpace": "NORMALIZED_IMAGE" },
    "detectorVersion": "gemini-photo-regions-v1",
    "expiresAt": "ISO8601",
    "original": { "elementId": "원본-UUID", "type": "ORIGINAL", "bbox": { "left": 0, "top": 0, "width": 400, "height": 800 } },
    "elements": [{ "elementId": "UUID", "type": "PHOTO_REGION", "bbox": { "left": 20, "top": 80, "width": 300, "height": 200 } }]
  }
}
```

좌표는 EXIF 방향 적용 후 이미지의 좌측 상단 기준 픽셀이다. FE는 같은 방향으로 원본을 표시하고 `표시너비/image.width`, `표시높이/image.height`로 좌표를 변환한다. elements는 최대 64개, 위→아래/좌→우 순서다. Gemini의 0~1000 정규화 좌표를 원본 크기의 정수 좌표로 검증·환산하고 중복 후보와 자식 사진이 있는 콜라주 외곽 박스를 제거한다. 32px 미만 또는 짧은 변/긴 변 비율 0.2 미만의 띠 형태 후보는 제외하므로 극단적인 파노라마도 제외될 수 있다. 사진 미검출은 201 + NO_CANDIDATES + elements=[]이며 전체 이미지를 자동 분석하지 않는다. 후보 신뢰도나 사진 확정 판정은 제공하지 않는다.

### 2. GET /api/analysis/image-uploads/{uploadId}

HTTP 200, 위와 같은 후보 구조 및 IMAGE_UPLOAD200. 소유권/만료 검사. 프로세스 재시작 이후에는 404.

### 3. POST /api/analysis/image-uploads/{uploadId}/analyses

application/json:

```json
{ "elementId": "선택한 후보 UUID" }
```

한 번에 한 개만 지원한다. original.elementId와 elements[].elementId를 동일한 요청 형식으로 선택할 수 있다. 추가 필드/임의 좌표는 400. PHOTO_REGION은 서버에 보관한 좌표로 정규화 이미지에서 사진을 자르고 PNG로 무손실 인코딩해 전달한다. ORIGINAL은 보관한 업로드 원본 바이트와 MIME을 그대로 전달하므로 EXIF·JPEG 인코딩도 원본과 동일하다. crop 자체가 원본 입력을 변경하므로 모델 성능 영향 검증이 필요하다. 선택한 elementId는 AI 호출 컨텍스트에도 사용된다.

HTTP 202, 기존 ANALYSIS202 응답. result.analysisId로 기존 GET /api/analysis/{analysisId} 조회. 해당 GET의 result.photoSelection에는 uploadId, elementId, bbox, imageWidth, imageHeight, coordinateSpace, preprocessingVersion 및 selectionType(ORIGINAL/PHOTO_REGION)이 포함된다. 기존 분석은 null. 사진 자체는 DB에 저장하지 않는다.

분석 성공 후 업로드를 삭제한다. AI 실패 시 업로드는 만료 전까지 재선택 가능하고, 기존 분석 경로에 실패 분석 기록이 남을 수 있다. 동일 업로드의 동시 분석/취소는 409. 요청은 동기 HTTP 방식이며 성공 응답 유실 후 동일 작업의 결과를 복원하는 멱등성 기능은 이번 범위에 없다.

### 4. DELETE /api/analysis/image-uploads/{uploadId}

HTTP 200 + IMAGE_UPLOAD200 + result=null. 사용자 취소 시 호출한다.

## 임시 보관·제한

- 프로세스 메모리에서 10분 보관, 30초마다 만료 청소, 성공/취소/종료 시 버퍼 지움.
- 단일 프로세스 MVP. 다중 인스턴스/재시작 복구가 필요하면 공유 TTL 저장소로 교체해야 한다.
- 사용자당 대기 업로드 최대 5개(처리 중 포함), 동시 추출 최대 2개.
- 임시 이미지와 처리 예약 합계 128 MiB, 추출당 최대 64 MiB 예약. 저장 공간/동시성 부족은 429.
- 원본 바이트와 정규화 이미지는 TTL 동안 메모리에 함께 보관하며 둘의 합계로 용량 제한을 적용한다. 원본 파일명, 원본 바이트, crop, EXIF를 DB에 저장하지 않는다. 분석 결과에는 출처 좌표만 추가한다.
- 400: 누락·손상·픽셀/프레임 제한·잘못된 요소. 401: 인증. 404: 없음·소유권·만료. 409: 분석 중. 413: 파일/정규화 크기. 415: 형식. 429: 처리/보관 제한. PHOTO_DETECTION503: 비전 API 설정·시간 초과·사용량·응답 좌표 오류. 분석 단계의 기존 500/503 유지.

## FE 순서

업로드 → elements를 이미지 위 선택 영역으로 표시 → 사용자가 전체 이미지 또는 사진 한 개 선택 → analyses 호출 → analysisId로 결과 조회 → 완료/실패 화면. NO_CANDIDATES는 사진 후보가 없다는 뜻이며 original은 그대로 선택 가능하다. FE는 “사진 영역을 찾지 못했어요. 전체 이미지를 분석할까요?”를 표시한다. 자동 원본 분석은 하지 않는다. 수동 좌표 보정 및 복수 선택은 미지원이다. 취소 시 DELETE를 호출한다.
