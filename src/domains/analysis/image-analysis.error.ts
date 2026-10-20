import { ApiError } from '../../common/http/api-error';

/** Internal classification only; the public response never includes upstream details. */
export class ImageAnalysisError extends ApiError {
  constructor(
    readonly failureKind:
      'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE' | 'UPSTREAM',
  ) {
    super(503, 'ANALYSIS503', '이미지 분석을 수행할 수 없습니다.');
  }
}
