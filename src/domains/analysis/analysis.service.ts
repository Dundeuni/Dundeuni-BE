import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Analysis } from '@prisma/client';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import sharp = require('sharp');
import { ApiError } from '../../common/http/api-error';
import { AnalysisRepository } from './analysis.repository';
import { AnalysisUsageService } from './analysis-usage.service';
import { ImageAnalysisService } from './image-analysis.service';

@Injectable()
export class AnalysisService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly imageAnalysis: ImageAnalysisService,
    private readonly usage: AnalysisUsageService,
    private readonly config: ConfigService,
  ) {}

  async create(userId: string, file: Express.Multer.File | undefined) {
    try {
      if (!file || file.size === 0)
        throw new ApiError(400, 'COMMON400', '이미지 파일이 필요합니다.');
      const maxSize = this.positiveConfig('ANALYSIS_MAX_FILE_BYTES');
      if (file.size > maxSize)
        throw new ApiError(
          413,
          'COMMON413',
          '이미지 크기 제한을 초과했습니다.',
        );
      const extension = extname(file.originalname).toLowerCase();
      const jpeg =
        file.mimetype === 'image/jpeg' &&
        ['.jpg', '.jpeg'].includes(extension) &&
        file.buffer.length >= 4 &&
        file.buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
      const png =
        file.mimetype === 'image/png' &&
        extension === '.png' &&
        file.buffer.length >= 8 &&
        file.buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!jpeg && !png)
        throw new ApiError(
          415,
          'COMMON415',
          'JPEG 또는 PNG 이미지와 일치하는 MIME/확장자/시그니처가 필요합니다.',
        );
      try {
        // metadata() alone accepts truncated files; decode all pixels before side effects.
        await sharp(file.buffer, { failOn: 'warning' }).stats();
      } catch {
        throw new ApiError(
          400,
          'COMMON400',
          '손상되었거나 읽을 수 없는 이미지 파일입니다.',
        );
      }
      const hash = createHash('sha256')
        .update('IMAGE\0')
        .update(file.mimetype)
        .update('\0')
        .update(file.buffer)
        .digest('hex');
      const expiresAt = new Date(
        Date.now() + this.positiveConfig('ANALYSIS_RETENTION_SECONDS') * 1000,
      );
      let analysis = await this.repository.create(userId, hash, expiresAt);
      let reserved = false;
      try {
        await this.usage.reserveAiUsage(userId, analysis.id);
        reserved = true;
        await this.repository.analyzing(analysis.id);
        const result = await this.imageAnalysis.analyze(file);
        analysis = await this.repository.complete(analysis.id, result);
        return this.response(analysis);
      } catch (error) {
        const apiError =
          error instanceof ApiError
            ? error
            : new ApiError(500, 'COMMON500', '분석 요청 처리에 실패했습니다.');
        const body = apiError.getResponse() as { code: string };
        try {
          await this.repository.fail(analysis.id, body.code);
        } finally {
          if (reserved) await this.usage.releaseAiUsage(userId, analysis.id);
        }
        throw apiError;
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        500,
        'COMMON500',
        '분석 요청 저장 또는 처리에 실패했습니다.',
      );
    } finally {
      // 메모리 업로드만 사용한다. 응답/실패 경로 모두 원본 버퍼를 정리한다.
      file?.buffer.fill(0);
    }
  }

  private positiveConfig(name: string): number {
    const value = Number(this.config.get<string>(name));
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ApiError(500, 'COMMON500', '분석 정책 설정이 필요합니다.');
    return value;
  }
  private response(analysis: Analysis) {
    return {
      isSuccess: true,
      code: 'ANALYSIS202',
      message: '분석 요청 생성에 성공했습니다.',
      result: {
        analysisId: analysis.id,
        type: analysis.type,
        status: analysis.status,
        aiGenerationScore: analysis.aiGenerationScore,
        aiRiskLevel: analysis.aiRiskLevel,
        reasons: analysis.reasons,
        modelVersion: analysis.modelVersion,
        errorCode: analysis.errorCode,
        createdAt: analysis.createdAt.toISOString(),
        completedAt: analysis.completedAt?.toISOString() ?? null,
        expiresAt: analysis.expiresAt.toISOString(),
      },
    };
  }
}
