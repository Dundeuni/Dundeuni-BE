import { PhoneHistoryService } from './phone-history.service';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import {
  AnalysisHistoryRepository,
  StoredHistory,
} from './analysis-history.repository';
import {
  AnalysisHistoryQueryDto,
  AnalysisHistoryListDto,
} from './dto/analysis-history-list.dto';
import { AnalysisHistoryDetailDto } from './dto/analysis-history-detail.dto';

@Injectable()
export class AnalysisHistoryService {
  constructor(
    private readonly repository: AnalysisHistoryRepository,
    private readonly phoneHistory: PhoneHistoryService,
  ) {}

  async list(userId: string, query: AnalysisHistoryQueryDto) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip) || skip > 2147483647)
      throw new ApiError(400, 'COMMON400', '페이지 범위가 너무 큽니다.');
    const [rows, total] = await this.repository.list(
      userId,
      skip,
      limit,
      new Date(),
    );
    const result: AnalysisHistoryListDto = {
      items: rows.map((row) => {
        const phone =
          row.type === 'PHONE'
            ? this.phoneHistory.project(row.phoneResult)
            : null;
        return {
          analysisId: row.id,
          type: row.type,
          targetSummary: phone?.maskedPhoneNumber ?? null,
          status: row.status,
          aiRiskLevel:
            row.type === 'PHONE' ? (phone?.riskLevel ?? null) : row.aiRiskLevel,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      page,
      limit,
      total,
      hasNext: skip + rows.length < total,
    };
    return this.success('검사 기록 목록 조회에 성공했습니다.', result);
  }

  async findOne(userId: string, analysisId: string) {
    const row = await this.repository.findOwnedActive(
      analysisId,
      userId,
      new Date(),
    );
    if (!row) throw this.notFound();
    return this.success(
      '검사 기록 상세 조회에 성공했습니다.',
      this.projectDetail(row),
    );
  }

  async deleteOne(userId: string, analysisId: string) {
    const { count } = await this.repository.deleteOwned(analysisId, userId);
    if (!count) throw this.notFound();
    return this.success('검사 기록 삭제에 성공했습니다.', {
      deletedCount: count,
    });
  }

  async deleteAll(userId: string) {
    const { count } = await this.repository.deleteAllOwned(userId);
    return this.success('검사 기록 전체 삭제에 성공했습니다.', {
      deletedCount: count,
    });
  }

  private projectDetail(row: StoredHistory): AnalysisHistoryDetailDto {
    const phone =
      row.type === 'PHONE' ? this.phoneHistory.project(row.phoneResult) : null;
    return {
      analysisId: row.id,
      type: row.type,
      status: row.status,
      aiGenerationScore: row.type === 'PHONE' ? null : row.aiGenerationScore,
      aiRiskLevel:
        row.type === 'PHONE' ? (phone?.riskLevel ?? null) : row.aiRiskLevel,
      reasons: phone
        ? phone.reasons.map((description) => ({ description }))
        : row.reasons === null
          ? null
          : Array.isArray(row.reasons)
            ? row.reasons.flatMap((reason) =>
                reason &&
                typeof reason === 'object' &&
                !Array.isArray(reason) &&
                typeof reason.description === 'string'
                  ? [{ description: reason.description }]
                  : [],
              )
            : [],
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      detail: phone,
    };
  }

  private success<T>(message: string, result: T) {
    return { isSuccess: true, code: 'ANALYSIS200', message, result };
  }
  private notFound() {
    return new ApiError(
      404,
      'COMMON404',
      '검사 기록이 없거나 조회할 수 없습니다.',
    );
  }
}
