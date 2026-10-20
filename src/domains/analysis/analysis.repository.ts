import { Injectable } from '@nestjs/common';
import {
  Analysis,
  AnalysisType,
  Prisma,
  ImageResultStatus,
  ImageModelKind,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ImageModelsPublicResultDto,
  ImageModelPublicResultDto,
} from './image-analysis-v1.dto';
import { ImageAnalysisResult } from './image-analysis.service';

@Injectable()
export class AnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(userId: string, requestHash: string, expiresAt: Date) {
    return this.prisma.analysis.create({
      data: {
        userId,
        requestHash,
        expiresAt,
        type: AnalysisType.IMAGE,
      },
    });
  }
  /** The unique insert is the execution claim; losers never reserve usage or call AI. */
  async claim(
    userId: string,
    requestHash: string,
    expiresAt: Date,
    idempotencyKey: string,
  ) {
    try {
      const analysis = await this.prisma.analysis.create({
        data: {
          userId,
          requestHash,
          expiresAt,
          idempotencyKey,
          type: AnalysisType.IMAGE,
        },
      });
      return { analysis, claimed: true };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      )
        throw error;
      const analysis = await this.prisma.analysis.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (!analysis) throw error;
      return { analysis, claimed: false };
    }
  }
  analyzing(id: string) {
    return this.prisma.analysis.update({
      where: { id },
      data: { status: 'ANALYZING' },
    });
  }
  complete(id: string, result: ImageAnalysisResult) {
    return this.prisma.analysis.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        aiGenerationScore: result.aiGenerationScore,
        aiRiskLevel: result.aiRiskLevel,
        modelVersion: result.modelVersion,
        reasons: result.reasons as Prisma.InputJsonValue,
        completedAt: new Date(),
      },
    });
  }
  /** AI wire 응답이 아닌 명시적으로 정규화한 BE projection만 받는다. */
  async saveModelResults(
    analysisId: string,
    result: ImageModelsPublicResultDto,
  ) {
    const writes = this.modelWrites(analysisId, result);
    await this.prisma.$transaction([
      ...writes,
      this.prisma.analysis.update({
        where: { id: analysisId },
        data: { imageResultStatus: result.status as ImageResultStatus },
      }),
    ]);
  }

  private modelWrites(analysisId: string, result: ImageModelsPublicResultDto) {
    const models: [ImageModelKind, ImageModelPublicResultDto | null][] = [
      ['GENERATION', result.generation],
      ['MANIPULATION', result.manipulation],
    ];
    return models.flatMap(([kind, value]) => {
      if (value === null) return []; // 미요청 모델의 기존 결과는 유지한다.
      if (
        !['SUCCEEDED', 'FAILED'].includes(value.status) ||
        (value.displayScore !== null &&
          (!Number.isInteger(value.displayScore) ||
            value.displayScore < 0 ||
            value.displayScore > 100)) ||
        !Array.isArray(value.reasons) ||
        value.reasons.some(
          (reason) => !reason || typeof reason.description !== 'string',
        ) ||
        !Array.isArray(value.limitations) ||
        value.limitations.some((text) => typeof text !== 'string') ||
        (value.status === 'FAILED' &&
          (!value.errorCode ||
            value.decision !== null ||
            value.displayScore !== null)) ||
        (value.status === 'SUCCEEDED' && value.decision === null) ||
        (value.status === 'SUCCEEDED' && value.errorCode !== null)
      ) {
        throw new Error('Invalid normalized model result');
      }
      // 화이트리스트: rawScore, 이미지/crop, localization, error 원문은 영구 저장하지 않는다.
      const data = {
        status: value.status,
        displayScore: value.displayScore,
        decision: value.decision,
        reasons: value.reasons.map((reason) => ({
          description: reason.description,
        })) as Prisma.InputJsonValue,
        limitations: value.limitations,
        modelName: value.modelName,
        modelVersion: value.modelVersion,
        policyVersion: value.policyVersion,
        errorCode: value.errorCode,
        retryable: value.retryable,
      };
      return [
        this.prisma.analysisModelResult.upsert({
          where: { analysisId_kind: { analysisId, kind } },
          create: { analysisId, kind, ...data },
          update: data,
        }),
      ];
    });
  }

  async completeV1(
    id: string,
    result: ImageModelsPublicResultDto,
    completedAt: Date,
  ): Promise<Analysis> {
    const generation =
      result.generation?.status === 'SUCCEEDED' ? result.generation : null;
    const writes = this.modelWrites(id, result);
    const saved = await this.prisma.$transaction([
      ...writes,
      this.prisma.analysis.update({
        where: { id },
        data: {
          status: result.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
          imageResultStatus: result.status,
          errorCode: result.status === 'FAILED' ? 'ANALYSIS503' : null,
          completedAt,
          // 미요청 generation은 기존 레거시 생성 결과도 덮어쓰지 않는다.
          ...(result.generation === null
            ? {}
            : {
                aiGenerationScore: generation?.displayScore ?? null,
                aiRiskLevel: null,
                reasons: generation
                  ? (generation.reasons as Prisma.InputJsonValue)
                  : Prisma.DbNull,
                modelVersion: generation?.modelVersion ?? null,
              }),
        },
      }),
    ]);
    return saved[saved.length - 1] as Analysis;
  }

  findWithModelResults(id: string) {
    return this.prisma.analysis.findUnique({
      where: { id },
      include: { modelResults: true },
    });
  }

  /** API/큐 호출 없음. 요약 미생성은 summaryStatus=null, 작업 시작은 PENDING. */
  saveSummary(
    id: string,
    value:
      | { status: 'PENDING' | 'FAILED' }
      | {
          status: 'COMPLETED';
          summary: string;
          model: string;
          summarizedAt: Date;
        },
  ) {
    if (
      value.status === 'COMPLETED' &&
      (!value.summary.trim() ||
        !value.model.trim() ||
        !Number.isFinite(value.summarizedAt.getTime()))
    ) {
      throw new Error('Invalid completed summary');
    }
    return this.prisma.analysis.update({
      where: { id },
      data: {
        summaryStatus: value.status,
        summary: value.status === 'COMPLETED' ? value.summary : null,
        summaryModel: value.status === 'COMPLETED' ? value.model : null,
        summarizedAt: value.status === 'COMPLETED' ? value.summarizedAt : null,
      },
    });
  }
  fail(id: string, errorCode: string) {
    return this.prisma.analysis.update({
      where: { id },
      data: { status: 'FAILED', errorCode, completedAt: new Date() },
    });
  }
}
