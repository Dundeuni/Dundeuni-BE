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
import { ApiError, ApiErrorFilter } from '../../common/http/api-error';
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
    summary: '이미지 또는 텍스트 분석 요청 생성',
    description:
      'IMAGE는 기존 multipart/form-data이며 부분 실패 202, 전체 실패/타임아웃 503입니다. TEXT는 application/json으로 요청하며 AI 호출 없이 QUEUED/202로 저장합니다. TEXT는 trim 후 5~3,000자, 미리보기 최대 200자만 보관하며 생성 후 30일 만료입니다. 원문은 저장하지 않습니다. URL은 미지원입니다.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'IMAGE 전용, TEXT에서 전달 시 COMMON400. 1~128자 공백 없는 ASCII. 사용자별 키. 완료는 202 재사용, 처리 중/만료/내용 충돌은 COMMON409. 실패는 기존 오류 재사용. 새 분석에는 새 키 사용.',
  })
  @ApiResponse({
    status: 409,
    description: 'COMMON409: 처리 중, 키/내용 충돌 또는 만료된 키',
  })
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['type', 'file'],
          properties: {
            type: {
              type: 'string',
              enum: ['IMAGE'],
              description: 'multipart/form-data 전용',
            },
            file: {
              type: 'string',
              format: 'binary',
              description: 'JPEG/PNG. 기존 파일 크기 제한 적용',
            },
          },
        },
        {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: { type: 'string', enum: ['TEXT'] },
            text: {
              type: 'string',
              minLength: 5,
              maxLength: 3000,
              description: 'application/json 전용. trim 후 검증, 원문 미보관.',
              example: '이 메시지가 의심스러워요.',
            },
          },
        },
      ],
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
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'TEXT 응답에 포함',
            },
            textPreview: {
              type: 'string',
              maxLength: 200,
              description:
                'TEXT 응답에 포함. AI 결과 필드는 TEXT 응답에서 제외',
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'COMMON400: 잘못된 type/file/text 또는 전송 형식, TEXT의 Idempotency-Key, AI 입력 오류(400/422)',
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
    @Body() body: CreateAnalysisDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('content-type') contentType?: string,
  ) {
    if (body.type === 'TEXT') {
      if (file || !/^application\/json(?:\s*;|$)/i.test(contentType ?? ''))
        throw new ApiError(
          400,
          'COMMON400',
          'TEXT는 application/json으로 요청해야 합니다.',
        );
      if (idempotencyKey !== undefined)
        throw new ApiError(
          400,
          'COMMON400',
          'TEXT 요청은 Idempotency-Key를 지원하지 않습니다.',
        );
      return this.service.createText('development-user', body.text);
    }
    // return this.service.create(request.user.id, file);
    return this.service.create('development-user', file, idempotencyKey);
  }
}
