import { AnalysisSummaryRepository } from './analysis-summary.repository';
import { Request } from 'express';
import {
  Body,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { UploadedImageCleanupInterceptor } from './uploaded-image-cleanup.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiExtraModels,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
// TODO: 로그인 구현 후 AccessTokenGuard와 인증 사용자 ID를 복원한다.
// import { UseGuards, Req } from '@nestjs/common';
// import { ApiBearerAuth } from '@nestjs/swagger';
// import { AccessTokenGuard, AuthenticatedRequest } from '../../common/auth/access-token.guard';
import { ApiErrorFilter } from '../../common/http/api-error';
import { CreateAnalysisDto } from './analysis.dto';
import { ImageModelsPublicResultDto } from './image-analysis-v1.dto';
import { AnalysisService } from './analysis.service';
import { AnalysisResultResponseDto } from './analysis-result.dto';

@ApiExtraModels(ImageModelsPublicResultDto)
@ApiTags('Analysis')
// @ApiBearerAuth()
@Controller('analysis')
// @UseGuards(AccessTokenGuard)
@UseFilters(ApiErrorFilter)
export class AnalysisController {
  constructor(
    private readonly service: AnalysisService,
    private readonly summaries: AnalysisSummaryRepository,
  ) {}

  @Get(':analysisId')
  @ApiOperation({
    summary: '이미지 분석 결과 상세 조회',
    description:
      '저장된 분석 및 모델별 결과를 조회합니다. 요약은 기존 /summary에서 별도로 조회합니다. 개발용 인증 정책 유지.',
  })
  @ApiResponse({ status: 200, type: AnalysisResultResponseDto })
  @ApiResponse({ status: 400, description: 'COMMON400: UUID 형식 오류' })
  @ApiResponse({
    status: 404,
    description: 'COMMON404: 없거나 다른 사용자/만료된 기록',
  })
  @ApiResponse({ status: 500, description: 'COMMON500: DB/내부 오류' })
  getResult(
    @Param('analysisId', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user?: { id: string } },
  ) {
    return this.service.findOne(request.user?.id ?? 'development-user', id);
  }

  @Get(':analysisId/summary')
  @ApiOperation({
    summary: '이미지 분석 비동기 요약 조회',
    description:
      'PENDING/FAILED는 summary=null. 비활성화 또는 작업 등록 전 summaryStatus=null. 개발용 인증 정책 유지.',
  })
  @ApiResponse({
    status: 200,
    description: 'ANALYSIS200: 요약 상태 조회',
    schema: {
      type: 'object',
      properties: {
        isSuccess: { type: 'boolean', example: true },
        code: { type: 'string', example: 'ANALYSIS200' },
        message: {
          type: 'string',
          example: '이미지 분석 요약 조회에 성공했습니다.',
        },
        result: {
          type: 'object',
          properties: {
            analysisId: { type: 'string', format: 'uuid' },
            summaryStatus: {
              type: 'string',
              enum: ['PENDING', 'COMPLETED', 'FAILED'],
              nullable: true,
            },
            summary: { type: 'string', nullable: true },
            summaryModel: { type: 'string', nullable: true },
            summarizedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'COMMON400: UUID 형식 오류' })
  @ApiResponse({
    status: 404,
    description: 'COMMON404: 없거나 다른 사용자/만료된 기록',
  })
  @ApiResponse({ status: 500, description: 'COMMON500: DB/내부 오류' })
  getSummary(
    @Param('analysisId', new ParseUUIDPipe()) id: string,
    @Req() request: Request & { user?: { id: string } },
  ) {
    return this.summaries.get(id, request.user?.id ?? 'development-user');
  }

  @Post()
  @HttpCode(202)
  @UseInterceptors(UploadedImageCleanupInterceptor, FileInterceptor('file'))
  @ApiOperation({
    summary: '이미지 분석 요청 생성',
    description:
      'P0 유형 IMAGE/TEXT/URL 중 IMAGE만 지원합니다. 점수는 AI 생성·변조 가능성이며 사기 확률이 아닙니다. AI_PROVIDER=mock은 CuRe/TruFor v0.2 개발 전용 가상 분석입니다. 부분 실패는 성공 모델을 보존하며 202, 전체 실패/타임아웃은 503. 위험도 매핑 미확정 시 null.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'file'],
      properties: {
        type: {
          type: 'string',
          enum: ['IMAGE'],
          description: '현재 IMAGE만 허용. TEXT/URL 미구현.',
        },
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG/PNG. ANALYSIS_MAX_FILE_BYTES 크기 제한 적용.',
        },
      },
    },
  })
  @ApiResponse({
    status: 202,
    description: '분석 요청 생성',
    schema: {
      type: 'object',
      properties: {
        isSuccess: { type: 'boolean', example: true },
        code: { type: 'string', example: 'ANALYSIS202' },
        message: { type: 'string', example: '분석 요청 생성에 성공했습니다.' },
        result: {
          type: 'object',
          properties: {
            analysisId: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['IMAGE', 'TEXT', 'URL'] },
            status: {
              type: 'string',
              enum: ['QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED'],
            },
            aiGenerationScore: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              nullable: true,
            },
            aiRiskLevel: {
              type: 'string',
              nullable: true,
              description: '기존 Provider 위험도. overallResult와 별개이며 사기 확률이 아닙니다. 정책 미확정 시 null.',
            },
            reasons: {
              type: 'array',
              nullable: true,
              items: {
                type: 'object',
                properties: { description: { type: 'string' } },
              },
            },
            modelVersion: { type: 'string', nullable: true },
            errorCode: { type: 'string', nullable: true },
            createdAt: { type: 'string', format: 'date-time' },
            completedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'COMMON400: type/file 누락, TEXT/URL 또는 잘못된 요청',
  })
  // @ApiResponse({ status: 401, description: 'AUTH401: 인증 실패' })
  @ApiResponse({ status: 413, description: 'COMMON413: 이미지 크기 초과' })
  @ApiResponse({ status: 415, description: 'COMMON415: 지원하지 않는 이미지' })
  @ApiResponse({
    status: 429,
    description: 'USAGE429: 이용량 초과 (Usage 연동 예정)',
  })
  @ApiResponse({
    status: 503,
    description: 'ANALYSIS503: Provider 미연동/장애',
  })
  @ApiResponse({ status: 500, description: 'COMMON500: DB/내부 오류' })
  create(
    @Req() request: Request & { user?: { id: string } },
    @Body() _body: CreateAnalysisDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    // return this.service.create(request.user.id, file);
    return this.service.create(request.user?.id ?? 'development-user', file);
  }
}
