import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AnalysisType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImageAnalysisResult } from './image-analysis.service';

@Injectable()
export class AnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(userId: string, requestHash: string, expiresAt: Date) {
    return this.prisma.analysis.create({
      data: {
        userId,
        // 기존 DB 스키마와 호환되도록 요청마다 내부 식별값을 생성한다.
        idempotencyKey: randomUUID(),
        requestHash,
        expiresAt,
        type: AnalysisType.IMAGE,
      },
    });
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
  fail(id: string, errorCode: string) {
    return this.prisma.analysis.update({
      where: { id },
      data: { status: 'FAILED', errorCode, completedAt: new Date() },
    });
  }
}
