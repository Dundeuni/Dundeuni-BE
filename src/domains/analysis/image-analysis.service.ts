import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  AiImageAnalysisResponseV02,
  ImageModelsPublicResultDto,
  ImageModelPublicResultDto,
} from './image-analysis-v1.dto';
import { Inject, Injectable } from '@nestjs/common';
import { validateAiImageResponseV02 } from './image-analysis-v1.validator';
import { ApiError } from '../../common/http/api-error';

export interface ImageAnalysisResult {
  aiGenerationScore: number;
  aiRiskLevel: string;
  reasons: { description: string }[];
  modelVersion: string;
}
export interface AiImageAnalysisRequestV1 {
  file: Express.Multer.File;
  analysisId: string;
  elementId: string;
  requestId: string;
  sourceType: 'IMAGE' | 'SCREEN_CROP';
  models: 'ALL' | 'GENERATION' | 'MANIPULATION';
  deadlineAt: string;
}
export interface ValidatedImageAnalysisV1 {
  format: 'v1';
  models: ImageModelsPublicResultDto;
  completedAt: Date;
}
export interface ImageAnalysisProvider {
  analyze(
    file: Express.Multer.File,
    request?: AiImageAnalysisRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export const IMAGE_ANALYSIS_PROVIDER = Symbol('IMAGE_ANALYSIS_PROVIDER');

@Injectable()
export class UnavailableImageAnalysisProvider implements ImageAnalysisProvider {
  async analyze(): Promise<ImageAnalysisResult> {
    // TODO: 실제 AI 계약 확정 후 Provider를 교체한다. 가짜 결과를 반환하지 않는다.
    throw new ApiError(
      503,
      'ANALYSIS503',
      '이미지 분석 Provider가 연결되지 않았습니다.',
    );
  }
}
@Injectable()
export class ImageAnalysisService {
  constructor(
    @Inject(IMAGE_ANALYSIS_PROVIDER)
    private readonly provider: ImageAnalysisProvider,
    private readonly config: ConfigService,
  ) {}
  // 실제 Provider 연동 시 사용할 내부 응답 검증 진입점. 기존 analyze 경로는 유지한다.
  validateV1Response(value: unknown) {
    return validateAiImageResponseV02(value);
  }

  async analyze(
    file: Express.Multer.File,
    request?: AiImageAnalysisRequestV1,
  ): Promise<ImageAnalysisResult | ValidatedImageAnalysisV1> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    try {
      const timeoutMs = Number(
        this.config.get<string>('AI_REQUEST_TIMEOUT_MS') ?? 30000,
      );
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 2147483647
      )
        throw new Error('Invalid AI timeout');
      const deadlineMs = request
        ? Date.parse(request.deadlineAt) - Date.now()
        : timeoutMs;
      if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
        throw new Error('AI deadline expired');
      const value = await Promise.race([
        this.provider.analyze(file, request, abort.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              reject(new Error('AI deadline exceeded'));
              abort.abort();
            },
            Math.min(timeoutMs, deadlineMs),
          );
        }),
      ]);
      if (value && typeof value === 'object' && 'contractVersion' in value) {
        const response = this.validateV1Response(value);
        if (
          !request ||
          response.analysisId !== request.analysisId ||
          response.elementId !== request.elementId ||
          response.requestId !== request.requestId ||
          response.sourceType !== request.sourceType
        )
          throw new Error('AI response context mismatch');
        const expected =
          request.models === 'ALL'
            ? (['generation', 'manipulation'] as const)
            : ([
                request.models === 'GENERATION' ? 'generation' : 'manipulation',
              ] as const);
        if (
          response.requestedModels.length !== expected.length ||
          !expected.every((name) => response.requestedModels.includes(name)) ||
          expected.includes('generation') !== (response.generation !== null) ||
          expected.includes('manipulation') !== (response.manipulation !== null)
        )
          throw new Error('AI requested model mismatch');
        if (
          response.analysisImage.inputSha256.toLowerCase() !==
          createHash('sha256').update(file.buffer).digest('hex')
        )
          throw new Error('AI input hash mismatch');
        return {
          format: 'v1',
          completedAt: new Date(response.completedAt),
          models: {
            status: response.status,
            generation: this.projectModel(response.generation, 'CuRe'),
            manipulation: this.projectModel(response.manipulation, 'TruFor'),
          },
        };
      }
      const result = value as ImageAnalysisResult;
      if (
        !Number.isFinite(result.aiGenerationScore) ||
        result.aiGenerationScore < 0 ||
        result.aiGenerationScore > 100 ||
        typeof result.aiRiskLevel !== 'string' ||
        !result.aiRiskLevel.trim() ||
        typeof result.modelVersion !== 'string' ||
        !result.modelVersion.trim() ||
        !Array.isArray(result.reasons) ||
        result.reasons.some((reason) => typeof reason.description !== 'string')
      ) {
        throw new Error('Invalid provider result');
      }
      return {
        aiGenerationScore: result.aiGenerationScore,
        aiRiskLevel: result.aiRiskLevel,
        reasons: result.reasons.map((reason) => ({
          description: reason.description,
        })),
        modelVersion: result.modelVersion,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        'ANALYSIS503',
        '이미지 분석을 수행할 수 없습니다.',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private projectModel(
    model: AiImageAnalysisResponseV02['generation'],
    name: 'CuRe' | 'TruFor',
  ): ImageModelPublicResultDto | null {
    if (!model) return null;
    return {
      status: model.status,
      modelName: name,
      modelVersion: model.modelVersion,
      policyVersion: model.policyVersion,
      displayScore: model.displayScore,
      decision: model.decision,
      reasons: model.reasons.map((description) => ({ description })),
      limitations: model.limitations,
      errorCode: model.errorCode,
      retryable: model.error ? model.error.retryable : null,
    };
  }
}
