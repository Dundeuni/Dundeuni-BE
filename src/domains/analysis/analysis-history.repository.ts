import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const summarySelect = {
  summary: true,
  summaryStatus: true,
  summaryModel: true,
  summarizedAt: true,
} satisfies Prisma.AnalysisSelect;

// Explicit projection: never expose requestHash, userId, raw payloads or future private fields.
const listSelect = {
  ...summarySelect,
  id: true,
  type: true,
  status: true,
  aiRiskLevel: true,
  createdAt: true,
} satisfies Prisma.AnalysisSelect;
const historySelect = {
  ...summarySelect,
  id: true,
  type: true,
  status: true,
  aiGenerationScore: true,
  aiRiskLevel: true,
  reasons: true,
  createdAt: true,
  completedAt: true,
  expiresAt: true,
  imageResultStatus: true,
  modelResults: { select: { kind: true, status: true, displayScore: true, decision: true, reasons: true, limitations: true, modelName: true, modelVersion: true, policyVersion: true, errorCode: true, retryable: true } },
} satisfies Prisma.AnalysisSelect;
export type StoredHistory = Prisma.AnalysisGetPayload<{
  select: typeof historySelect;
}>;

@Injectable()
export class AnalysisHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, skip: number, take: number, now: Date) {
    const where = { userId, expiresAt: { gt: now } };
    // A consistent snapshot keeps items and total aligned during concurrent writes/deletes.
    return this.prisma.$transaction(
      [
        this.prisma.analysis.findMany({
          where,
          select: listSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take,
        }),
        this.prisma.analysis.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  findOwnedActive(analysisId: string, userId: string, now: Date) {
    return this.prisma.analysis.findFirst({
      where: { id: analysisId, userId, expiresAt: { gt: now } },
      select: historySelect,
    });
  }

  deleteOwned(analysisId: string, userId: string) {
    // Predicate and deletion are atomic; no check-then-delete ownership race.
    return this.prisma.analysis.deleteMany({
      where: { id: analysisId, userId },
    });
  }

  deleteAllOwned(userId: string) {
    // One SQL statement, with existing ON DELETE CASCADE for model results.
    return this.prisma.analysis.deleteMany({ where: { userId } });
  }
}
