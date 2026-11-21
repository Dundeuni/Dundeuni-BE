import { AiImageAnalysisResponseV02 } from './image-analysis-v1.dto';
import {
  calculateOverallResult,
  pilotDecision,
  pilotDisplayScore,
} from './image-analysis-policy';
import { validateLocalization } from './image-localization.validator';
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

/** v0.2에서는 contractVersion=1.0이며 기존 공통 검증 뒤 추가 규칙을 검사한다. */
export function validateAiImageResponseV02(
  value: unknown,
): AiImageAnalysisResponseV02 {
  if (!record(value)) throw new Error('Invalid v0.2 response');
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
    'overallResult',
    'completedAt',
  ]);
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    value.contractVersion !== '1.0' ||
    typeof value.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.requestId,
    ) ||
    typeof value.analysisId !== 'string' ||
    !uuid.test(value.analysisId) ||
    typeof value.elementId !== 'string' ||
    !uuid.test(value.elementId) ||
    !['IMAGE', 'SCREEN_CROP'].includes(String(value.sourceType)) ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    !/(Z|\+00:00)$/.test(value.completedAt) ||
    !['COMPLETED', 'PARTIAL_FAILED', 'FAILED'].includes(String(value.status))
  )
    throw new Error('Invalid v0.2 envelope');
  if (
    !record(value.analysisImage) ||
    typeof value.analysisImage.inputSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.analysisImage.inputSha256) ||
    !Number.isInteger(value.analysisImage.width) ||
    !Number.isInteger(value.analysisImage.height) ||
    (value.analysisImage.width as number) < 32 ||
    (value.analysisImage.height as number) < 32 ||
    (value.analysisImage.width as number) > 8192 ||
    (value.analysisImage.height as number) > 8192 ||
    (value.analysisImage.width as number) *
      (value.analysisImage.height as number) >
      16000000 ||
    typeof value.analysisImage.normalizationVersion !== 'string' ||
    !value.analysisImage.normalizationVersion.trim()
  )
    throw new Error('Invalid analysis image');
  const typed = value as unknown as AiImageAnalysisResponseV02;
  const expectedModels = (['generation', 'manipulation'] as const).filter(
    (kind) => typed[kind] !== null,
  );
  if (
    !Array.isArray(typed.requestedModels) ||
    !expectedModels.length ||
    JSON.stringify(typed.requestedModels) !== JSON.stringify(expectedModels)
  )
    throw new Error('Invalid requested models');
  for (const kind of expectedModels) {
    const item = typed[kind];
    if (!record(item)) throw new Error('Invalid requested model');
    required(item, [
      'status',
      'rawScore',
      'displayScore',
      'decision',
      'decisionLabel',
      'reasons',
      'limitations',
      'modelVersion',
      'policyVersion',
      'errorCode',
      'error',
      'localization',
    ]);
    if (
      !['SUCCEEDED', 'FAILED'].includes(String(item.status)) ||
      (item.modelName !== undefined &&
        item.modelName !== (kind === 'generation' ? 'CuRe' : 'TruFor')) ||
      'map' in item ||
      'conf' in item ||
      'imgsize' in item ||
      typeof item.modelVersion !== 'string' ||
      !item.modelVersion.trim() ||
      typeof item.policyVersion !== 'string' ||
      !item.policyVersion.trim() ||
      !Array.isArray(item.reasons) ||
      item.reasons.length > 5 ||
      item.reasons.some((reason) => typeof reason !== 'string') ||
      !Array.isArray(item.limitations) ||
      item.limitations.length > 8 ||
      item.limitations.some((text) => typeof text !== 'string')
    )
      throw new Error('Invalid v0.2 model details');
    if (item.status === 'FAILED') {
      if (
        item.rawScore !== null ||
        item.displayScore !== null ||
        item.decision !== null ||
        item.decisionLabel !== null ||
        item.localization !== null ||
        item.reasons.length ||
        item.limitations.length ||
        typeof item.errorCode !== 'string' ||
        !item.errorCode.trim() ||
        !record(item.error) ||
        item.error.code !== item.errorCode ||
        typeof item.error.message !== 'string' ||
        typeof item.error.retryable !== 'boolean'
      )
        throw new Error('Invalid failed model');
    } else {
      if (
        !record(item.rawScore) ||
        Object.keys(item.rawScore).length !== 1 ||
        typeof item.rawScore.score !== 'number'
      )
        throw new Error('Invalid raw score object');
      const decision = pilotDecision(kind, item.rawScore.score);
      if (
        item.decision !== decision ||
        item.displayScore !==
          pilotDisplayScore(item.rawScore.score, decision) ||
        typeof item.decisionLabel !== 'string' ||
        !item.decisionLabel.trim() ||
        item.errorCode !== null ||
        item.error !== null ||
        (decision === 'INCONCLUSIVE' && item.reasons.length)
      )
        throw new Error('Invalid pilot result');
    }
    if (kind === 'generation' && item.localization !== null)
      throw new Error('Generation localization must be null');
    validateLocalization(item.localization);
    if (
      item.localization !== null &&
      (item.localization.imageSize.width !== typed.analysisImage.width ||
        item.localization.imageSize.height !== typed.analysisImage.height)
    )
      throw new Error('Localization context mismatch');
  }
  const statuses = expectedModels.map((kind) => typed[kind]!.status);
  const expectedStatus = statuses.every((status) => status === 'FAILED')
    ? 'FAILED'
    : statuses.includes('FAILED')
      ? 'PARTIAL_FAILED'
      : 'COMPLETED';
  if (typed.status !== expectedStatus)
    throw new Error('Invalid aggregate status');
  const expected = calculateOverallResult(typed.generation, typed.manipulation);
  if (
    !record(typed.overallResult) ||
    typed.overallResult.decision !== expected.decision ||
    typed.overallResult.decisionLabel !== expected.decisionLabel ||
    typed.overallResult.policyVersion !== expected.policyVersion ||
    JSON.stringify(typed.overallResult.suspectedKinds) !==
      JSON.stringify(expected.suspectedKinds) ||
    JSON.stringify(typed.overallResult.uncertainKinds) !==
      JSON.stringify(expected.uncertainKinds) ||
    'score' in typed.overallResult ||
    'displayScore' in typed.overallResult ||
    'rawScore' in typed.overallResult
  )
    throw new Error('Invalid overall result');
  return typed;
}
