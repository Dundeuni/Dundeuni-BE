import { ApiError } from '../../common/http/api-error';

export const TEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** #96 integration input, request memory only. Never enqueue, persist or log text. */
export interface TextAnalysisInput {
  analysisId: string;
  elementId?: string;
  userId: string;
  text: string;
}

/** #96 can implement this port; #13 does not register or call an AI provider. */
export interface TextAnalysisProvider {
  analyze(input: TextAnalysisInput, signal: AbortSignal): Promise<unknown>;
  analyzeImage?(
    file: Express.Multer.File,
    context: {
      analysisId: string;
      elementId: string;
      sourceType: 'IMAGE' | 'SCREEN_CROP';
    },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export function normalizeTextInput(value: unknown): string {
  if (typeof value !== 'string')
    throw new ApiError(400, 'COMMON400', 'text는 필수 문자열입니다.');
  const text = value.trim();
  const length = Array.from(text).length;
  if (length < 5 || length > 3000)
    throw new ApiError(
      400,
      'COMMON400',
      'text는 앞뒤 공백 제거 후 5~3,000자여야 합니다.',
    );
  return text;
}
