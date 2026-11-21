import {
  AiModelDecision,
  AiModelResultV1,
  ImageOverallResult,
  ImageModelPublicResultDto,
} from './image-analysis-v1.dto';
export type ModelKind = 'generation' | 'manipulation';
export function pilotDecision(kind: ModelKind, score: number): AiModelDecision {
  if (!Number.isFinite(score) || score < 0 || score > 1)
    throw new Error('Invalid raw score');
  if (kind === 'generation')
    return score < 0.000004
      ? 'NO_CLEAR_GENERATION_SIGNAL'
      : score < 0.02
        ? 'INCONCLUSIVE'
        : 'AI_GENERATED_SUSPECTED';
  return score < 0.12
    ? 'NO_CLEAR_MANIPULATION_SIGNAL'
    : score < 0.7
      ? 'INCONCLUSIVE'
      : 'MANIPULATION_SUSPECTED';
}
export function pilotDisplayScore(
  score: number,
  decision: AiModelDecision,
): number | null {
  return decision === 'INCONCLUSIVE' ? null : Math.floor(score * 100 + 0.5);
}
export const DECISION_LABELS: Record<AiModelDecision, string> = {
  AI_GENERATED_SUSPECTED: 'AI 생성 의심',
  NO_CLEAR_GENERATION_SIGNAL: '뚜렷한 생성 신호 없음',
  MANIPULATION_SUSPECTED: '이미지 변조 의심',
  NO_CLEAR_MANIPULATION_SIGNAL: '뚜렷한 변조 신호 없음',
  INCONCLUSIVE: '판단 불가',
};
type DecisionModel = Pick<
  AiModelResultV1 | ImageModelPublicResultDto,
  'status' | 'decision'
>;
/** Prisma에서 조회한 모델별 결과에도 사용할 수 있다. 점수는 합산하지 않는다. */
export function calculateOverallResult(
  generation: DecisionModel | null,
  manipulation: DecisionModel | null,
): ImageOverallResult {
  const suspectedKinds: ModelKind[] = [],
    uncertainKinds: ModelKind[] = [];
  for (const [kind, model] of [
    ['generation', generation],
    ['manipulation', manipulation],
  ] as const) {
    if (
      !model ||
      model.status === 'FAILED' ||
      model.decision === 'INCONCLUSIVE'
    )
      uncertainKinds.push(kind);
    else if (
      model.decision === 'AI_GENERATED_SUSPECTED' ||
      model.decision === 'MANIPULATION_SUSPECTED'
    )
      suspectedKinds.push(kind);
  }
  const decision = suspectedKinds.length
    ? 'GENERATION_OR_MANIPULATION_SUSPECTED'
    : uncertainKinds.length
      ? 'INCONCLUSIVE'
      : 'NO_CLEAR_SIGNAL';
  return {
    decision,
    decisionLabel:
      decision === 'GENERATION_OR_MANIPULATION_SUSPECTED'
        ? '생성·변조 의심'
        : decision === 'INCONCLUSIVE'
          ? '판단 불가'
          : '뚜렷한 신호 없음',
    policyVersion: 'image-overall-v1',
    suspectedKinds,
    uncertainKinds,
  };
}
