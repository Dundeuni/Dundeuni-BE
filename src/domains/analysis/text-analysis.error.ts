import { ApiError } from '../../common/http/api-error';
import type { ImageAnalysisError } from './image-analysis.error';

/** Same PB-23 failure categories and public code; no upstream body or credentials. */
export class TextAnalysisError extends ApiError {
  constructor(
    readonly failureKind: ImageAnalysisError['failureKind'],
    readonly upstreamStatus?: number,
  ) {
    super(503, 'ANALYSIS503', '텍스트 분석을 수행할 수 없습니다.');
  }
}
