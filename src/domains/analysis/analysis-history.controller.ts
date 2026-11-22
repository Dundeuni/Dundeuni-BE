import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AccessTokenGuard,
  AuthenticatedRequest,
} from '../../common/auth/access-token.guard';
import { ApiErrorFilter } from '../../common/http/api-error';
import { AnalysisHistoryService } from './analysis-history.service';
import {
  AnalysisHistoryQueryDto,
  AnalysisHistoryListResponseDto,
} from './dto/analysis-history-list.dto';
import {
  AnalysisHistoryDeleteResponseDto,
  AnalysisHistoryDetailResponseDto,
  AnalysisHistoryErrorResponseDto,
} from './dto/analysis-history-detail.dto';

@ApiTags('Analysis history')
@ApiBearerAuth()
@ApiResponse({
  status: 401,
  description: 'AUTH401: JWT 누락·무효·만료',
  type: AnalysisHistoryErrorResponseDto,
})
@ApiResponse({
  status: 500,
  description: 'COMMON500: 인증 설정 또는 내부 오류',
  type: AnalysisHistoryErrorResponseDto,
})
@Controller('analysis/history')
@UseGuards(AccessTokenGuard)
@UseFilters(ApiErrorFilter)
export class AnalysisHistoryController {
  constructor(private readonly service: AnalysisHistoryService) {}

  @Get()
  @ApiOperation({
    summary: '검사 기록 통합 목록',
    description:
      '본인 미만료 기록을 createdAt DESC, id DESC로 조회합니다. 현재 저장된 expiresAt 정책을 사용하며 외부 AI를 호출하지 않습니다.',
  })
  @ApiResponse({ status: 200, type: AnalysisHistoryListResponseDto })
  @ApiResponse({
    status: 400,
    description: 'COMMON400: 페이지 번호·크기·범위 오류',
    type: AnalysisHistoryErrorResponseDto,
  })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: AnalysisHistoryQueryDto,
  ) {
    return this.service.list(request.user.id, query);
  }

  @Get(':analysisId')
  @ApiOperation({
    summary: '검사 기록 상세',
    description:
      'DB에 저장된 과거 결과만 반환합니다. 분석 실행 직후 결과 API와 별도 경로입니다. IMAGE detail은 저장된 Gemini 요약과 상태를 반환합니다. 다른 유형 상세는 후속 구현 전까지 null입니다.',
  })
  @ApiParam({ name: 'analysisId', format: 'uuid' })
  @ApiResponse({ status: 200, type: AnalysisHistoryDetailResponseDto })
  @ApiResponse({
    status: 400,
    description: 'COMMON400: 잘못된 UUID',
    type: AnalysisHistoryErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'COMMON404: 없거나 타 사용자·만료·삭제된 기록',
    type: AnalysisHistoryErrorResponseDto,
  })
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('analysisId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.findOne(request.user.id, id);
  }

  @Delete(':analysisId')
  @ApiOperation({
    summary: '검사 기록 개별 삭제',
    description:
      '본인 기록과 연관 모델 결과를 영구 삭제합니다. 만료된 본인 기록도 삭제할 수 있습니다.',
  })
  @ApiParam({ name: 'analysisId', format: 'uuid' })
  @ApiResponse({ status: 200, type: AnalysisHistoryDeleteResponseDto })
  @ApiResponse({
    status: 400,
    description: 'COMMON400: 잘못된 UUID',
    type: AnalysisHistoryErrorResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'COMMON404: 없거나 타 사용자·이미 삭제된 기록',
    type: AnalysisHistoryErrorResponseDto,
  })
  deleteOne(
    @Req() request: AuthenticatedRequest,
    @Param('analysisId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.deleteOne(request.user.id, id);
  }

  @Delete()
  @ApiOperation({
    summary: '검사 기록 전체 삭제',
    description:
      '현재 사용자의 기록만 만료 여부와 관계없이 영구 삭제합니다. 빈 기록도 성공합니다.',
  })
  @ApiResponse({ status: 200, type: AnalysisHistoryDeleteResponseDto })
  deleteAll(@Req() request: AuthenticatedRequest) {
    return this.service.deleteAll(request.user.id);
  }
}
