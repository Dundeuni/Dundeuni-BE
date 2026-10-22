import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Analysis } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../../common/http/api-error';
import { AnalysisRepository } from './analysis.repository';
import { TEXT_ANALYSIS_PROVIDER } from './http-text-analysis.provider';
import { TextAnalysisProvider, TEXT_RETENTION_MS } from './text-analysis.input';
import { TextAnalysisError } from './text-analysis.error';
import {
  storedTextRiskResult,
  validateTextRiskResponse,
} from './text-risk.dto';

/** Opt-in integration path. #13's disabled/QUEUED path remains unchanged. No retries or raw-input jobs. */
@Injectable()
export class TextAiWorkflowService {
  private readonly logger = new Logger(TextAiWorkflowService.name);
  constructor(
    private readonly repository: AnalysisRepository,
    @Inject(TEXT_ANALYSIS_PROVIDER)
    private readonly provider: TextAnalysisProvider,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, text: string, key?: string) {
    if (key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(key))
      throw new ApiError(
        400,
        'COMMON400',
        '올바른 Idempotency-Key가 필요합니다.',
      );
    const hash = createHash('sha256')
      .update('TEXT\0')
      .update(text)
      .digest('hex');
    const textPreview = Array.from(text).slice(0, 200).join('');
    const createdAt = new Date();
    let analysis: Analysis;
    try {
      const claim =
        key === undefined
          ? {
              analysis: await this.repository.createText(
                userId,
                hash,
                textPreview,
              ),
              claimed: true,
            }
          : await this.repository.claim(
              userId,
              hash,
              new Date(createdAt.getTime() + TEXT_RETENTION_MS),
              key,
              { textPreview, createdAt },
            );
      analysis = claim.analysis;
      if (!claim.claimed) {
        if (analysis.requestHash !== hash || analysis.type !== 'TEXT')
          throw new ApiError(
            409,
            'COMMON409',
            '같은 키로 다른 요청을 보낼 수 없습니다.',
          );
        if (analysis.expiresAt.getTime() <= Date.now())
          throw new ApiError(
            409,
            'COMMON409',
            '만료된 키입니다. 새 키를 사용해 주세요.',
          );
        if (analysis.status === 'COMPLETED' && analysis.textResult !== null)
          return this.response(analysis);
        if (analysis.status === 'FAILED') {
          const code =
            analysis.errorCode === 'ANALYSIS503' ? 'ANALYSIS503' : 'COMMON500';
          throw new ApiError(
            code === 'ANALYSIS503' ? 503 : 500,
            code,
            '이전 TEXT 분석 요청이 실패했습니다. 새 분석에는 새 키를 사용해 주세요.',
          );
        }
        throw new ApiError(
          409,
          'COMMON409',
          '분석 처리 중입니다. 잠시 후 같은 키로 다시 요청해 주세요.',
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        500,
        'COMMON500',
        'TEXT 분석 요청 저장에 실패했습니다.',
      );
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.repository.analyzing(analysis.id);
      const timeout = Number(
        this.config.get<string>('AI_REQUEST_TIMEOUT_MS') ?? 30000,
      );
      if (
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        timeout > 2147483647
      )
        throw new ApiError(
          500,
          'COMMON500',
          'AI 제한 시간 설정이 올바르지 않습니다.',
        );
      const elementId = randomUUID();
      const deadline = Date.now() + timeout;
      const value = await Promise.race([
        this.provider.analyze(
          { analysisId: analysis.id, elementId, userId, text },
          abort.signal,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new TextAnalysisError('TIMEOUT'));
          }, timeout);
        }),
      ]);
      if (abort.signal.aborted || Date.now() >= deadline)
        throw new TextAnalysisError('TIMEOUT');
      const result = validateTextRiskResponse(value, {
        analysisId: analysis.id,
        elementId,
        sourceType: 'TEXT',
      });
      const saved = await this.repository.completeText(
        analysis.id,
        storedTextRiskResult(result),
      );
      return this.response(saved);
    } catch (error) {
      const failure =
        error instanceof ApiError
          ? error
          : new ApiError(
              500,
              'COMMON500',
              'TEXT 분석 결과 저장에 실패했습니다.',
            );
      try {
        await this.repository.fail(
          analysis.id,
          (failure.getResponse() as { code: string }).code,
        );
      } catch {
        this.logger.error('Failed to persist TEXT analysis failure state');
      }
      throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private response(row: Analysis) {
    return {
      isSuccess: true,
      code: 'ANALYSIS202',
      message: '분석 요청 생성에 성공했습니다.',
      result: {
        analysisId: row.id,
        type: row.type,
        status: row.status,
        textPreview: row.textPreview,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        textResult: row.textResult,
      },
    };
  }
}
