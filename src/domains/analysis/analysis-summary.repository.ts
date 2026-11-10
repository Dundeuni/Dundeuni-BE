import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiError } from '../../common/http/api-error';
import { randomUUID } from 'node:crypto';
import { AnalysisSummaryJob } from '@prisma/client';
import {
  positiveSetting,
  retryDelay,
  SummaryError,
} from './gemini-summary.client';

@Injectable()
export class AnalysisSummaryRepository {
  private readonly logger = new Logger(AnalysisSummaryRepository.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  enabled() {
    return this.config.get('GEMINI_SUMMARY_ENABLED') === 'true';
  }
  async enqueue(analysisId: string) {
    if (!this.enabled()) return;
    // Separate transaction AFTER model persistence: enqueue failure never rolls image results back.
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.analysis.updateMany({
        where: {
          id: analysisId,
          type: 'IMAGE',
          imageResultStatus: { not: null },
          status: { in: ['COMPLETED', 'FAILED'] },
          summaryStatus: null,
          modelResults: { some: {} },
          expiresAt: { gt: new Date() },
        },
        data: {
          summaryStatus: 'PENDING',
          summary: null,
          summaryModel: null,
          summarizedAt: null,
        },
      });
      if (changed.count)
        await tx.analysisSummaryJob.create({
          data: { analysisId, nextRunAt: new Date(), createdAt: new Date() },
        });
    });
  }
  async enqueueSafely(analysisId: string) {
    try {
      await this.enqueue(analysisId);
    } catch {
      this.logger.warn('SUMMARY_ENQUEUE_FAILED');
    }
  }
  async reconcile() {
    const rows = await this.prisma.analysis.findMany({
      where: {
        type: 'IMAGE',
        imageResultStatus: { not: null },
        status: { in: ['COMPLETED', 'FAILED'] },
        summaryStatus: null,
        modelResults: { some: {} },
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
    for (const row of rows) await this.enqueue(row.id);
  }
  async claim(): Promise<AnalysisSummaryJob | null> {
    const token = randomUUID();
    const leaseMs =
      positiveSetting(this.config, 'GEMINI_TIMEOUT_MS', 15000) + 30000;
    const rows = await this.prisma.$queryRaw<AnalysisSummaryJob[]>`
      WITH candidate AS (
        SELECT j."analysisId" FROM "analysis_summary_jobs" j
        JOIN "analysis_requests" a ON a.id = j."analysisId"
        WHERE a."summaryStatus" = 'PENDING' AND
          ((j.status = 'PENDING' AND j."nextRunAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
           OR (j.status = 'RUNNING' AND j."leaseUntil" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))
        ORDER BY j."nextRunAt", j."analysisId" FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) UPDATE "analysis_summary_jobs" j SET status = 'RUNNING', attempts = attempts + 1,
        "leaseToken" = ${token}::uuid, "leaseUntil" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + ${leaseMs} * interval '1 millisecond',
        "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') FROM candidate c WHERE j."analysisId" = c."analysisId" RETURNING j.*`;
    return rows[0] ?? null;
  }
  async finish(
    job: AnalysisSummaryJob,
    output: { summary: string; model: string } | SummaryError,
  ) {
    const maxAttempts = positiveSetting(
      this.config,
      'GEMINI_SUMMARY_MAX_ATTEMPTS',
      3,
      10,
    );
    const retry =
      output instanceof SummaryError &&
      output.retryable &&
      job.attempts < maxAttempts;
    const delay = retryDelay(
      this.config,
      job.attempts,
      output instanceof SummaryError && output.code === 'GEMINI_RATE_LIMIT',
    );
    return this.prisma.$transaction(async (tx) => {
      const owned = await tx.analysisSummaryJob.updateMany({
        where: {
          analysisId: job.analysisId,
          status: 'RUNNING',
          leaseToken: job.leaseToken,
          leaseUntil: { gt: new Date() },
        },
        data: {
          status: retry
            ? 'PENDING'
            : output instanceof SummaryError
              ? 'FAILED'
              : 'COMPLETED',
          leaseToken: null,
          leaseUntil: null,
          nextRunAt: new Date(Date.now() + delay),
          lastErrorCode: output instanceof SummaryError ? output.code : null,
        },
      });
      if (!owned.count) return false; // Fencing: expired/replaced workers cannot commit.
      const changed = await tx.analysis.updateMany({
        where: { id: job.analysisId, summaryStatus: 'PENDING' },
        data:
          output instanceof SummaryError
            ? {
                summaryStatus: retry ? 'PENDING' : 'FAILED',
                summary: null,
                summaryModel: null,
                summarizedAt: null,
              }
            : {
                summaryStatus: 'COMPLETED',
                summary: output.summary,
                summaryModel: output.model,
                summarizedAt: new Date(),
              },
      });
      if (!changed.count) throw new SummaryError('SUMMARY_STATE_CONFLICT');
      return true;
    });
  }
  /** Administrative CLI only: no unauthenticated recovery endpoint. */
  async recoverFailed(analysisId: string) {
    if (!this.enabled()) throw new SummaryError('SUMMARY_DISABLED');
    return this.prisma.$transaction(async (tx) => {
      // Same job -> Analysis lock order as finish to avoid concurrent deadlocks.
      const changed = await tx.analysisSummaryJob.updateMany({
        where: { analysisId, status: 'FAILED' },
        data: {
          status: 'PENDING',
          attempts: 0,
          nextRunAt: new Date(),
          leaseUntil: null,
          leaseToken: null,
          lastErrorCode: null,
        },
      });
      if (!changed.count) throw new SummaryError('SUMMARY_RECOVERY_NOT_FAILED');
      const analysis = await tx.analysis.updateMany({
        where: {
          id: analysisId,
          summaryStatus: 'FAILED',
          type: 'IMAGE',
          status: { in: ['COMPLETED', 'FAILED'] },
          imageResultStatus: { not: null },
          modelResults: { some: {} },
          expiresAt: { gt: new Date() },
        },
        data: {
          summaryStatus: 'PENDING',
          summary: null,
          summaryModel: null,
          summarizedAt: null,
        },
      });
      if (!analysis.count)
        throw new SummaryError('SUMMARY_RECOVERY_NOT_ELIGIBLE');
      this.logger.log('SUMMARY_RECOVERY_REGISTERED');
      return { status: 'PENDING' as const };
    });
  }
  async models(id: string) {
    return this.prisma.analysis.findUnique({
      where: { id },
      include: { modelResults: true },
    });
  }
  async get(id: string, userId: string) {
    const row = await this.prisma.analysis.findFirst({
      where: { id, userId, expiresAt: { gt: new Date() } },
    });
    if (!row)
      throw new ApiError(404, 'COMMON404', '분석 기록을 찾을 수 없습니다.');
    return {
      isSuccess: true,
      code: 'ANALYSIS200',
      message: '이미지 분석 요약 조회에 성공했습니다.',
      result: {
        analysisId: row.id,
        summaryStatus: row.summaryStatus,
        summary: row.summaryStatus === 'COMPLETED' ? row.summary : null,
        summaryModel:
          row.summaryStatus === 'COMPLETED' ? row.summaryModel : null,
        summarizedAt:
          row.summaryStatus === 'COMPLETED'
            ? (row.summarizedAt?.toISOString() ?? null)
            : null,
      },
    };
  }
}
