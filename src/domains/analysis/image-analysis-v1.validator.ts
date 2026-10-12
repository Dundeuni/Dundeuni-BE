import {
  AiImageAnalysisResponseV1,
  AiModelResultV1,
} from './image-analysis-v1.dto';
const decisions = [
  'AI_GENERATED_SUSPECTED',
  'NO_CLEAR_GENERATION_SIGNAL',
  'MANIPULATION_SUSPECTED',
  'NO_CLEAR_MANIPULATION_SIGNAL',
  'INCONCLUSIVE',
];
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function required(value: Record<string, unknown>, keys: string[]) {
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)))
    throw new Error('Missing v1 field');
}
function model(
  value: unknown,
  generation: boolean,
): asserts value is AiModelResultV1 | null {
  if (value === null) return;
  if (!record(value)) throw new Error('Invalid model result');
  required(value, [
    'status',
    'modelName',
    'modelVersion',
    'policyVersion',
    'rawScore',
    'displayScore',
    'decision',
    'reasons',
    'limitations',
    'localization',
    'errorCode',
    'error',
  ]);
  if (
    !['SUCCEEDED', 'FAILED'].includes(String(value.status)) ||
    ['modelName', 'modelVersion', 'policyVersion'].some(
      (key) => typeof value[key] !== 'string' || !(value[key] as string).trim(),
    ) ||
    (value.displayScore !== null &&
      (!Number.isInteger(value.displayScore) ||
        (value.displayScore as number) < 0 ||
        (value.displayScore as number) > 100)) ||
    (value.status === 'SUCCEEDED' &&
      !decisions.includes(String(value.decision))) ||
    !Array.isArray(value.reasons) ||
    !Array.isArray(value.limitations)
  )
    throw new Error('Invalid model fields');
  if (generation && value.localization !== null)
    throw new Error('Generation localization must be null');
  if (value.localization !== null && !record(value.localization))
    throw new Error('Invalid localization');
  if (value.status === 'FAILED') {
    if (value.decision !== null || value.displayScore !== null)
      throw new Error('Failed model must have null decision and score');
    if (
      typeof value.errorCode !== 'string' ||
      !value.errorCode.trim() ||
      !record(value.error) ||
      value.error.code !== value.errorCode
    )
      throw new Error('Inconsistent model error');
  } else if (value.errorCode !== null || value.error !== null)
    throw new Error('Successful model cannot have error');
  // 미확정 중첩 필드와 requestedModels 대응은 실제 HTTP 어댑터 연결 전에 추가 검증해야 한다.
}
export function validateAiImageResponseV1(
  value: unknown,
): AiImageAnalysisResponseV1 {
  if (!record(value)) throw new Error('Invalid AI v1 response');
  required(value, [
    'contractVersion',
    'requestId',
    'analysisId',
    'elementId',
    'sourceType',
    'requestedModels',
    'status',
    'analysisImage',
    'generation',
    'manipulation',
    'completedAt',
  ]);
  if (
    ['contractVersion', 'requestId', 'analysisId', 'completedAt'].some(
      (key) => typeof value[key] !== 'string' || !(value[key] as string).trim(),
    ) ||
    !Number.isFinite(Date.parse(value.completedAt as string)) ||
    !Array.isArray(value.requestedModels) ||
    !['COMPLETED', 'PARTIAL_FAILED', 'FAILED'].includes(String(value.status))
  )
    throw new Error('Invalid AI root fields');
  model(value.generation, true);
  model(value.manipulation, false);
  const statuses = [value.generation, value.manipulation]
    .filter((item): item is AiModelResultV1 => item !== null)
    .map((item) => item.status);
  if (
    (value.status === 'COMPLETED' && statuses.includes('FAILED')) ||
    (value.status === 'FAILED' && statuses.includes('SUCCEEDED')) ||
    (value.status === 'PARTIAL_FAILED' &&
      (!statuses.includes('SUCCEEDED') || !statuses.includes('FAILED')))
  ) {
    throw new Error('Inconsistent aggregate status');
  }
  return value as unknown as AiImageAnalysisResponseV1;
}
