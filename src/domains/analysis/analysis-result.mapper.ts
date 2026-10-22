import { Analysis, AnalysisModelResult, Prisma } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class NormalizedAnalysisResultDto {
  @ApiProperty({
    enum: ['UNKNOWN'],
    description:
      '공통 위험도 정책 미확정. 모델 점수로 위험 단계를 추정하지 않음.',
  })
  riskLevel!: 'UNKNOWN';
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['normal', 'phishing', 'defer'],
    description: '원본 TEXT 모델 판정. 공통 위험도와 별개.',
  })
  textDecision!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1,
    description: 'TEXT 미보정 분류 점수. 이미지 점수와 비교 불가.',
  })
  riskScore!: number | null;
  @ApiProperty({ type: String, nullable: true, enum: ['0..1'] })
  scoreScale!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['UNCALIBRATED_CLASSIFIER_SCORE'],
  })
  scoreMeaning!: string | null;
  @ApiProperty({
    type: [String],
    description: '성공한 이미지 모델의 저장된 근거. TEXT 자유문구는 미보관.',
  })
  reasons!: string[];
  @ApiProperty({
    type: [String],
    description: 'Safety 정책 미구현으로 빈 배열.',
  })
  guidance!: string[];
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'COMPLETED 상태의 저장된 요약만 제공. 조회 중 생성하지 않음.',
  })
  summary!: string | null;
}

export type AnalysisWithResults = Analysis & {
  modelResults: AnalysisModelResult[];
};
function descriptions(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    typeof item.description === 'string' &&
    item.description.trim()
      ? [item.description]
      : [],
  );
}

/** Read-only projection. Never expose request hashes, raw input or free-form TEXT evidence. */
export function mapAnalysisResult(row: AnalysisWithResults) {
  const completed = row.status === 'COMPLETED';
  const text =
    row.textResult &&
    typeof row.textResult === 'object' &&
    !Array.isArray(row.textResult)
      ? row.textResult
      : null;
  const validText =
    completed &&
    text?.analysisId === row.id &&
    ['TEXT', 'IMAGE', 'SCREEN_CROP'].includes(text.sourceType as string) &&
    ['normal', 'phishing', 'defer'].includes(text.decision as string) &&
    text.scoreScale === '0..1' &&
    text.scoreMeaning === 'UNCALIBRATED_CLASSIFIER_SCORE';
  const score =
    validText &&
    typeof text.riskScore === 'number' &&
    Number.isFinite(text.riskScore) &&
    text.riskScore >= 0 &&
    text.riskScore <= 1
      ? text.riskScore
      : null;
  const models = row.modelResults ?? [];
  const reasons = !completed
    ? []
    : models.length
      ? models
          .filter((m) => m.status === 'SUCCEEDED')
          .flatMap((m) => descriptions(m.reasons))
      : row.type === 'IMAGE'
        ? descriptions(row.reasons)
        : [];
  const normalized: NormalizedAnalysisResultDto = {
    riskLevel: 'UNKNOWN',
    textDecision: validText ? (text.decision as string) : null,
    riskScore: score,
    scoreScale: validText ? '0..1' : null,
    scoreMeaning: validText ? 'UNCALIBRATED_CLASSIFIER_SCORE' : null,
    reasons,
    guidance: [],
    summary:
      completed && row.summaryStatus === 'COMPLETED' && row.summary?.trim()
        ? row.summary
        : null,
  };
  return {
    analysisId: row.id,
    type: row.type,
    sourceType:
      text &&
      ['TEXT', 'IMAGE', 'SCREEN_CROP'].includes(text.sourceType as string)
        ? text.sourceType
        : row.type === 'IMAGE' || row.type === 'TEXT'
          ? row.type
          : null,
    status: row.status,
    // Existing IMAGE creation field names are retained, without rewriting their meaning.
    aiGenerationScore: row.aiGenerationScore,
    aiRiskLevel: row.aiRiskLevel,
    reasons: row.type === 'IMAGE' ? row.reasons : null,
    modelVersion: row.modelVersion,
    errorCode: row.errorCode,
    imageResultStatus: row.imageResultStatus,
    modelResults: models.map(
      ({
        kind,
        status,
        displayScore,
        decision,
        reasons,
        limitations,
        modelName,
        modelVersion,
        policyVersion,
        errorCode,
        retryable,
      }) => ({
        kind,
        status,
        displayScore,
        decision,
        reasons: descriptions(reasons).map((description) => ({ description })),
        limitations,
        modelName,
        modelVersion,
        policyVersion,
        errorCode,
        retryable,
      }),
    ),
    result: normalized,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
  };
}
