import {
  Body,
  Controller,
  HttpCode,
  Headers,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { UploadedImageCleanupInterceptor } from './uploaded-image-cleanup.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiHeader,
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

@ApiExtraModels(ImageModelsPublicResultDto)
@ApiTags('Analysis')
// @ApiBearerAuth()
@Controller('analysis')
// @UseGuards(AccessTokenGuard)
@UseFilters(ApiErrorFilter)
export class AnalysisController {
  constructor(private readonly service: AnalysisService) {}

  @Post()
  @HttpCode(202)
  @UseInterceptors(UploadedImageCleanupInterceptor, FileInterceptor('file'))
  @ApiOperation({
    summary: '이미지 분석 요청 생성',
    description:
      'P0 유형 IMAGE/TEXT/URL 중 IMAGE만 지원합니다. 점수는 AI 생성·변조 가능성이며 사기 확률이 아닙니다. AI_PROVIDER=mock은 CuRe/TruFor v0.2 개발 전용 가상 분석이며, AI_PROVIDER=http은 Bearer 서비스 인증을 사용하는 내부 HTTP 어댑터입니다. 서버 설정으로만 전환합니다. 부분 실패는 성공 모델을 보존하며 202, 전체 실패/타임아웃은 503. 위험도 매핑 미확정 시 null.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      '1~128자 공백 없는 ASCII. 사용자별 키. 완료는 202 재사용, 처리 중/만료/내용 충돌은 COMMON409. 실패는 기존 오류 재사용. 새 분석에는 새 키 사용.',
  })
  @ApiResponse({
    status: 409,
    description: 'COMMON409: 처리 중, 키/내용 충돌 또는 만료된 키',
  })
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
              description: 'Provider 계약 미확정. CAUTION 등, 확정 판정 아님.',
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
    description:
      'COMMON400: type/file 누락, TEXT/URL 또는 잘못된 요청, AI 입력 오류(400/422)',
  })
  // @ApiResponse({ status: 401, description: 'AUTH401: 인증 실패' })
  @ApiResponse({
    status: 413,
    description: 'COMMON413: 업로드 또는 AI 전송 파일·본문 크기 초과',
  })
  @ApiResponse({ status: 415, description: 'COMMON415: 지원하지 않는 이미지' })
  @ApiResponse({
    status: 429,
    description: 'USAGE429: 이용량 초과 (Usage 연동 예정)',
  })
  @ApiResponse({
    status: 503,
    description:
      'ANALYSIS503: Provider 미연동, AI 서비스 인증/네트워크/타임아웃/비정상 응답/전체 모델 실패',
  })
  @ApiResponse({ status: 500, description: 'COMMON500: DB/내부 오류' })
  create(
    // @Req() request: AuthenticatedRequest,
    @Body() _body: CreateAnalysisDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // return this.service.create(request.user.id, file);
    return this.service.create('development-user', file, idempotencyKey);
  }
}
