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
    validateMockRequest(request);
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
        generationRequested ? 'GENERATION' : null,
        manipulationRequested ? 'MANIPULATION' : null,
      ].filter((value) => value !== null),
      status,
      analysisImage: null,
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
      this.scenario === 'NO_CLEAR_SIGNAL'
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
        ? PNG.sync.write(new PNG({ width: 1, height: 1 }))
        : null;
    return {
      status: failed ? 'FAILED' : 'SUCCEEDED',
      modelName: name,
      modelVersion: `${name}-mock-v0.2`,
      policyVersion: 'mock-pilot-v0.2',
      rawScore: failed ? null : score,
      displayScore: failed ? null : pilotDisplayScore(score, decision!),
      decision,
      decisionLabel: decision === null ? null : DECISION_LABELS[decision],
      reasons: failed
        ? []
        : [{ description: `[MOCK] ${name} 고정 가상 분석 근거` }],
      limitations: failed
        ? []
        : ['MOCK 응답이며 실제 AI 분석 결과가 아닙니다.'],
      localization: png
        ? {
            format: 'PNG_BASE64',
            kind: 'MANIPULATION_HEATMAP',
            mimeType: 'image/png',
            data: png.toString('base64'),
            imageSize: { width: 1, height: 1 },
            mapSize: { width: 1, height: 1 },
            coordinateSpace: 'ANALYSIS_IMAGE',
          }
        : null,
      errorCode: failed ? 'MOCK_MODEL_FAILED' : null,
      error: failed ? { code: 'MOCK_MODEL_FAILED', retryable: false } : null,
    };
  }
}
export class HttpImageAnalysisProviderUnavailable extends UnavailableImageAnalysisProvider {
  async analyze(): Promise<never> {
    throw new ApiError(
      503,
      'ANALYSIS503',
      'HTTP AI Provider가 아직 구현되지 않았습니다.',
    );
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
  if (mode === 'http') return new HttpImageAnalysisProviderUnavailable();
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

export function validateMockRequest(request: AiImageAnalysisRequestV1): void {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const v4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(request.analysisId) ||
    !uuid.test(request.elementId) ||
    !v4.test(request.requestId) ||
    !['IMAGE', 'SCREEN_CROP'].includes(request.sourceType) ||
    !['ALL', 'GENERATION', 'MANIPULATION'].includes(request.models) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(
      request.deadlineAt,
    ) ||
    !Number.isFinite(Date.parse(request.deadlineAt)) ||
    Date.parse(request.deadlineAt) <= Date.now()
  )
    throw new Error('Invalid v0.2 request context');
}
