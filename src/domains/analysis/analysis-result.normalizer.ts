/** Public display text only. Never rewrite stored/provider verdicts or infer scores. */
export function normalizeTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (typeof item !== 'string') return [];
        const text = item.replace(/\s+/gu, ' ').trim();
        return text ? [text] : [];
      }),
    ),
  ];
}

export function normalizeReasons(value: unknown): { description: string }[] {
  if (!Array.isArray(value)) return [];
  return normalizeTexts(
    value.map((reason) =>
      reason && typeof reason === 'object' && !Array.isArray(reason)
        ? (reason as { description?: unknown }).description
        : null,
    ),
  ).map((description) => ({ description }));
}

import {
  ImageModelPublicResultDto,
  ImageOverallResult,
} from './image-analysis-v1.dto';

export function resultGuides(
  overall: ImageOverallResult,
  generation: ImageModelPublicResultDto | null,
  manipulation: ImageModelPublicResultDto | null,
): string[] {
  const guides =
    overall.decision === 'GENERATION_OR_MANIPULATION_SUSPECTED'
      ? [
          '사진이나 정보의 출처를 확인해 주세요.',
          '공유하기 전에 다른 자료와 비교해 주세요.',
          '관련 기관의 공식 홈페이지나 전화로 확인해 주세요.',
        ]
      : overall.decision === 'INCONCLUSIVE'
        ? [
            '현재 분석만으로는 판단하기 어렵습니다.',
            '원본 사진이나 추가 자료를 확인해 주세요.',
          ]
        : [
            '뚜렷한 의심 신호는 발견되지 않았습니다.',
            '원본 사진이거나 안전한 정보라는 뜻은 아닙니다.',
          ];
  if (generation?.status === 'FAILED')
    guides.push('AI 생성 분석에 실패해 생성 여부를 판단할 수 없습니다.');
  if (manipulation?.status === 'FAILED')
    guides.push('이미지 변조 분석에 실패해 수정 여부를 판단할 수 없습니다.');
  return guides;
}
