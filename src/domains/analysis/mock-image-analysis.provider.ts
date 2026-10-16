import { createHash } from 'node:crypto';
import { validateImageAnalysisRequest } from './image-analysis-request.validator';
export { validateImageAnalysisRequest as validateMockRequest } from './image-analysis-request.validator';
import { HttpImageAnalysisProvider } from './http-image-analysis.provider';
import { PNG } from 'pngjs';
import {
  calculateOverallResult,
  pilotDecision,
  pilotDisplayScore,
  DECISION_LABELS,
} from './image-analysis-policy';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/http/api-error';
import {
  AiImageAnalysisResponseV02,
  AiModelResultV02,
} from './image-analysis-v1.dto';
import {
  AiImageAnalysisRequestV1,
  ImageAnalysisProvider,
  UnavailableImageAnalysisProvider,
} from './image-analysis.service';

export const MOCK_SCENARIOS = [
  'BOTH_SUCCESS',
  'GENERATION_SUSPECTED',
  'MANIPULATION_SUSPECTED',
  'GENERATION_FAILED',
  'MANIPULATION_FAILED',
  'BOTH_FAILED',
  'INCONCLUSIVE',
  'TIMEOUT',
  'NO_CLEAR_SIGNAL',
  'BOTH_INCONCLUSIVE',
  'LOCALIZATION',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** 협의 초안용 고정 fixture. 실제 이미지 추론 또는 모델 성능을 나타내지 않는다. */
export class MockImageAnalysisProvider implements ImageAnalysisProvider {
  constructor(private readonly scenario: MockScenario) {}
  async analyze(
    _file: Express.Multer.File,
    request?: AiImageAnalysisRequestV1,
    signal?: AbortSignal,
  ): Promise<AiImageAnalysisResponseV02> {
    if (!request) throw new Error('Mock requires v1 request context');
    validateImageAnalysisRequest(request);
    if (this.scenario === 'TIMEOUT') {
      return new Promise((_, reject) => {
        const abort = () => reject(new Error('Mock aborted'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    const generationRequested = request.models !== 'MANIPULATION';
    const manipulationRequested = request.models !== 'GENERATION';
    const generation = generationRequested
      ? this.model(
          'CuRe',
          this.scenario === 'GENERATION_FAILED' ||
            this.scenario === 'BOTH_FAILED',
          this.scenario === 'INCONCLUSIVE' ||
            this.scenario === 'BOTH_INCONCLUSIVE',
        )
      : null;
    const manipulation = manipulationRequested
      ? this.model(
          'TruFor',
          this.scenario === 'MANIPULATION_FAILED' ||
            this.scenario === 'BOTH_FAILED',
          this.scenario === 'BOTH_INCONCLUSIVE',
        )
      : null;
    const statuses = [generation, manipulation]
      .filter((value) => value !== null)
      .map((value) => value.status);
    const status = statuses.every((value) => value === 'FAILED')
      ? 'FAILED'
      : statuses.includes('FAILED')
        ? 'PARTIAL_FAILED'
        : 'COMPLETED';
    return {
      contractVersion: '1.0',
      requestId: request.requestId,
      analysisId: request.analysisId,
      elementId: request.elementId,
      sourceType: request.sourceType,
      requestedModels: [
        generationRequested ? ('generation' as const) : null,
        manipulationRequested ? ('manipulation' as const) : null,
      ].filter((value) => value !== null),
      status,
      analysisImage: {
        inputSha256: createHash('sha256').update(_file.buffer).digest('hex'),
        width: 32,
        height: 32,
        normalizationVersion: 'mock-normalization-v0.2',
      },
      generation,
      manipulation,
      overallResult: calculateOverallResult(generation, manipulation),
      completedAt: new Date().toISOString(),
    };
  }
  private model(
    name: 'CuRe' | 'TruFor',
    failed: boolean,
    inconclusive: boolean,
  ): AiModelResultV02 {
    const kind = name === 'CuRe' ? 'generation' : 'manipulation';
    const score =
      this.scenario === 'NO_CLEAR_SIGNAL' ||
      (this.scenario === 'GENERATION_SUSPECTED' && name === 'TruFor') ||
      (this.scenario === 'MANIPULATION_SUSPECTED' && name === 'CuRe')
        ? name === 'CuRe'
          ? 0.000001
          : 0.1
        : inconclusive
          ? name === 'CuRe'
            ? 0.01
            : 0.4
          : 0.8;
    const decision = failed ? null : pilotDecision(kind, score);
    const png =
      this.scenario === 'LOCALIZATION' && name === 'TruFor'
        ? PNG.sync.write(new PNG({ width: 1, height: 1 }), { colorType: 0 })
        : null;
    return {
      status: failed ? 'FAILED' : 'SUCCEEDED',
      modelName: name,
      modelVersion: `${name}-mock-v0.2`,
      policyVersion: 'mock-pilot-v0.2',
      rawScore: failed ? null : { score },
      displayScore: failed ? null : pilotDisplayScore(score, decision!),
      decision,
      decisionLabel: decision === null ? null : DECISION_LABELS[decision],
      reasons:
        failed || inconclusive ? [] : [`[MOCK] ${name} 점수 기반 검토 문구`],
      limitations: failed
        ? []
        : ['MOCK 응답이며 실제 AI 분석 결과가 아닙니다.'],
      localization: png
        ? {
            format: 'PNG_BASE64',
            kind: 'MANIPULATION_HEATMAP',
            mimeType: 'image/png',
            data: png.toString('base64'),
            imageSize: { width: 32, height: 32 },
            mapSize: { width: 1, height: 1 },
            coordinateSpace: 'ANALYSIS_IMAGE',
          }
        : null,
      errorCode: failed ? 'MOCK_MODEL_FAILED' : null,
      error: failed
        ? {
            code: 'MOCK_MODEL_FAILED',
            message: 'Mock model failed',
            retryable: false,
          }
        : null,
    };
  }
}
export function selectImageAnalysisProvider(
  config: ConfigService,
): ImageAnalysisProvider {
  const timeoutMs = Number(
    config.get<string>('AI_REQUEST_TIMEOUT_MS') ?? 30000,
  );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('AI_REQUEST_TIMEOUT_MS must be a positive integer');
  const mode = config.get<string>('AI_PROVIDER') ?? 'unavailable';
  if (mode === 'unavailable') return new UnavailableImageAnalysisProvider();
  if (mode === 'http') return new HttpImageAnalysisProvider(config);
  if (mode !== 'mock')
    throw new Error('AI_PROVIDER must be mock, http or unavailable');
  if (config.get<string>('NODE_ENV') === 'production')
    throw new Error('Mock AI Provider is forbidden in production');
  const scenario = config.get<string>('AI_MOCK_SCENARIO') ?? 'BOTH_SUCCESS';
  if (!MOCK_SCENARIOS.includes(scenario as MockScenario))
    throw new Error('Invalid AI_MOCK_SCENARIO');
  new Logger('ImageAnalysisProvider').warn(
    `MOCK AI enabled (${scenario}); results are synthetic`,
  );
  return new MockImageAnalysisProvider(scenario as MockScenario);
}
