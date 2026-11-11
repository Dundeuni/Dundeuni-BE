import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequestUserGuard } from '../../common/auth/request-user.guard';
import { AuthenticatedRequest } from '../../common/auth/access-token.guard';
import { ApiError, ApiErrorFilter } from '../../common/http/api-error';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('History')
@ApiBearerAuth()
@Controller('history')
@UseGuards(RequestUserGuard)
@UseFilters(ApiErrorFilter)
export class HistoryController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: '이미지·텍스트·전화번호 분석 기록 목록 (최신순)' })
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    const take = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 100)
      throw new ApiError(400, 'COMMON400', 'limit은 1~100 정수여야 합니다.');
    const items = await this.prisma.analysis.findMany({
      where: { userId: request.user.id, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        completedAt: true,
        expiresAt: true,
        textPreview: true,
        errorCode: true,
        phoneResult: { select: { phoneNumber: true, riskLevel: true } },
      },
    });
    return {
      isSuccess: true,
      code: 'HISTORY200',
      message: '분석 기록 조회에 성공했습니다.',
      result: { items },
    };
  }

  @Get(':analysisId')
  @ApiOperation({
    summary: '분석 기록 상세: 텍스트 결과·전화번호 결과·이미지 모델 결과',
  })
  async detail(
    @Req() request: AuthenticatedRequest,
    @Param('analysisId', new ParseUUIDPipe()) id: string,
  ) {
    const row = await this.prisma.analysis.findFirst({
      where: { id, userId: request.user.id, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        type: true,
        status: true,
        createdAt: true,
        completedAt: true,
        expiresAt: true,
        errorCode: true,
        textPreview: true,
        textResult: true,
        photoSelection: true,
        modelResults: {
          select: {
            kind: true,
            modelName: true,
            modelVersion: true,
            policyVersion: true,
            status: true,
            decision: true,
            displayScore: true,
            reasons: true,
            limitations: true,
            errorCode: true,
            retryable: true,
          },
        },
        phoneResult: {
          select: {
            phoneNumber: true,
            provider: true,
            riskLevel: true,
            spamType: true,
            reportCount: true,
            reasons: true,
            policyVersion: true,
            analyzedAt: true,
          },
        },
      },
    });
    if (!row)
      throw new ApiError(404, 'COMMON404', '분석 기록을 찾을 수 없습니다.');
    return {
      isSuccess: true,
      code: 'HISTORY200',
      message: '분석 기록 조회에 성공했습니다.',
      result: row,
    };
  }
}
