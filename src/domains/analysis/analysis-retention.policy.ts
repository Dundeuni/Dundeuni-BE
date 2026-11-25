import { ApiError } from '../../common/http/api-error';

export const MAX_ANALYSIS_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** Preserve shorter configured retention while enforcing the maximum for new analyses. */
export function analysisExpiresAt(seconds: number, now = new Date()): Date {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isFinite(now.getTime())
  )
    throw new ApiError(
      500,
      'COMMON500',
      '분석 보관 기간 설정이 올바르지 않습니다.',
    );
  return new Date(
    now.getTime() + Math.min(seconds, MAX_ANALYSIS_RETENTION_SECONDS) * 1000,
  );
}
