import { TextAnalysisError } from './text-analysis.error';

export interface TextRiskQuality {
  needsReview: boolean;
  reasonCodes: string[];
  ocrUsed: boolean;
  poorOcrConfidence: boolean;
  layoutUncertain: boolean;
  contextDisagreement: boolean;
}
/** Deployed text-risk-1.0 contract, deliberately independent of IMAGE scores. */
export interface TextRiskResultDto {
  contractVersion?: 'text-risk-1.0';
  requestId: string;
  analysisId: string;
  elementId: string;
  sourceType: 'TEXT' | 'IMAGE' | 'SCREEN_CROP';
  status?: 'COMPLETED';
  decision: 'normal' | 'phishing' | 'defer';
  riskScore: number | null;
  scoreScale: '0..1';
  scoreMeaning: 'UNCALIBRATED_CLASSIFIER_SCORE';
  modelName: string;
  modelVersion: string;
  policyVersion: string;
  quality: TextRiskQuality;
  evidence: string[];
  limitations: string[];
  processingMs: number;
}
/** No echoed text, OCR, or free-form evidence/limitations in persistent/public replay data. */
export type StoredTextRiskResult = Omit<
  TextRiskResultDto,
  'evidence' | 'limitations'
>;

export function validateTextRiskResponse(
  value: unknown,
  context: {
    analysisId: string;
    elementId: string;
    sourceType: TextRiskResultDto['sourceType'];
  },
): TextRiskResultDto {
  const fail = (): never => {
    throw new TextAnalysisError('INVALID_RESPONSE');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  const v = value as Record<string, unknown>;
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) &&
    x.length <= 128 &&
    x.every((s) => typeof s === 'string' && s.length <= 4096);
  if (
    (v.contractVersion !== undefined &&
      v.contractVersion !== 'text-risk-1.0') ||
    (v.status !== undefined && v.status !== 'COMPLETED') ||
    v.analysisId !== context.analysisId ||
    v.elementId !== context.elementId ||
    v.sourceType !== context.sourceType ||
    typeof v.requestId !== 'string' ||
    !uuid.test(v.requestId) ||
    !['normal', 'phishing', 'defer'].includes(v.decision as string) ||
    (v.riskScore !== null &&
      (typeof v.riskScore !== 'number' ||
        !Number.isFinite(v.riskScore) ||
        v.riskScore < 0 ||
        v.riskScore > 1)) ||
    v.scoreScale !== '0..1' ||
    v.scoreMeaning !== 'UNCALIBRATED_CLASSIFIER_SCORE' ||
    typeof v.text !== 'string' ||
    !strings(v.evidence) ||
    !strings(v.limitations) ||
    typeof v.processingMs !== 'number' ||
    !Number.isFinite(v.processingMs) ||
    v.processingMs < 0
  )
    return fail();
  for (const key of ['modelName', 'modelVersion', 'policyVersion'])
    if (
      typeof v[key] !== 'string' ||
      !(v[key] as string).trim() ||
      (v[key] as string).length > 200
    )
      return fail();
  if (!v.quality || typeof v.quality !== 'object' || Array.isArray(v.quality))
    return fail();
  const q = v.quality as Record<string, unknown>;
  const bools = [
    'needsReview',
    'ocrUsed',
    'poorOcrConfidence',
    'layoutUncertain',
    'contextDisagreement',
  ] as const;
  if (bools.some((k) => typeof q[k] !== 'boolean') || !strings(q.reasonCodes))
    return fail();
  return {
    ...(v.contractVersion !== undefined
      ? { contractVersion: 'text-risk-1.0' as const }
      : {}),
    requestId: v.requestId,
    analysisId: context.analysisId,
    elementId: context.elementId,
    sourceType: context.sourceType,
    ...(v.status !== undefined ? { status: 'COMPLETED' as const } : {}),
    decision: v.decision as TextRiskResultDto['decision'],
    riskScore: v.riskScore as number | null,
    scoreScale: '0..1',
    scoreMeaning: 'UNCALIBRATED_CLASSIFIER_SCORE',
    modelName: v.modelName as string,
    modelVersion: v.modelVersion as string,
    policyVersion: v.policyVersion as string,
    quality: {
      needsReview: q.needsReview as boolean,
      reasonCodes: [...q.reasonCodes],
      ocrUsed: q.ocrUsed as boolean,
      poorOcrConfidence: q.poorOcrConfidence as boolean,
      layoutUncertain: q.layoutUncertain as boolean,
      contextDisagreement: q.contextDisagreement as boolean,
    },
    evidence: [...v.evidence],
    limitations: [...v.limitations],
    processingMs: v.processingMs,
  };
}

export function storedTextRiskResult(
  result: TextRiskResultDto,
): StoredTextRiskResult {
  return {
    ...(result.contractVersion !== undefined
      ? { contractVersion: result.contractVersion }
      : {}),
    requestId: result.requestId,
    analysisId: result.analysisId,
    elementId: result.elementId,
    sourceType: result.sourceType,
    ...(result.status !== undefined ? { status: result.status } : {}),
    decision: result.decision,
    riskScore: result.riskScore,
    scoreScale: result.scoreScale,
    scoreMeaning: result.scoreMeaning,
    modelName: result.modelName,
    modelVersion: result.modelVersion,
    policyVersion: result.policyVersion,
    quality: result.quality,
    processingMs: result.processingMs,
  };
}
