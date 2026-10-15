import { Inject, Injectable } from '@nestjs/common';
import { validateAiImageResponseV1 } from './image-analysis-v1.validator';
import { ApiError } from '../../common/http/api-error';

export interface ImageAnalysisResult {
  aiGenerationScore: number;
  aiRiskLevel: string;
  reasons: { description: string }[];
  modelVersion: string;
}
export interface ImageAnalysisProvider {
  analyze(file: Express.Multer.File): Promise<ImageAnalysisResult>;
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
  ) {}
  // 실제 Provider 연동 시 사용할 내부 응답 검증 진입점. 기존 analyze 경로는 유지한다.
  validateV1Response(value: unknown) {
    return validateAiImageResponseV1(value);
  }
  async analyze(file: Express.Multer.File): Promise<ImageAnalysisResult> {
    try {
      const result = await this.provider.analyze(file);
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
    } catch {
      throw new ApiError(
        503,
        'ANALYSIS503',
        '이미지 분석을 수행할 수 없습니다.',
      );
    }
  }
}
