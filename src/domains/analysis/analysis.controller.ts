import { analysisRequestBody } from './analysis.swagger';
import { RequestUserGuard } from '../../common/auth/request-user.guard';
import { Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, getSchemaPath } from '@nestjs/swagger';
import { AuthenticatedRequest } from '../../common/auth/access-token.guard';
import { NormalizedAnalysisResultDto } from './analysis-result.mapper';
import {
  Body,
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
  ApiHeader,
  ApiExtraModels,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiError, ApiErrorFilter } from '../../common/http/api-error';
import { CreateAnalysisDto } from './analysis.dto';
import { ImageModelsPublicResultDto } from './image-analysis-v1.dto';
import { AnalysisService } from './analysis.service';

function errorSchema(code: string) {
  return {
    type: 'object',
    properties: {
      isSuccess: { type: 'boolean', example: false },
      code: { type: 'string', example: code },
      message: { type: 'string' },
      result: { type: 'object', nullable: true, example: null },
    },
  };
}

@ApiExtraModels(ImageModelsPublicResultDto, NormalizedAnalysisResultDto)
@ApiTags('Analysis')
@ApiBearerAuth()
@Controller('analysis')
@UseGuards(RequestUserGuard)
@UseFilters(ApiErrorFilter)
export class AnalysisController {
  constructor(private readonly service: AnalysisService) {}

  @Get(':analysisId')
  @ApiOperation({
    summary: '분석 결과 조회',
    description:
      'NODE_ENV=development에서만 Bearer 없이 development-user로 조회(토큰 전달 시에도 동일). production 및 그 외 환경은 JWT Bearer 필수, JWT sub로 소유권 검사. 본인 소유의 만료 전 기록만 조회. ANALYZING은 처리 중. AI/Gemini 호출 없음.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        isSuccess: { type: 'boolean' },
        code: { type: 'string', example: 'ANALYSIS200' },
        message: { type: 'string' },
        result: {
          type: 'object',
          properties: {
            analysisId: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: ['IMAGE', 'TEXT', 'URL'] },
            sourceType: {
              type: 'string',
              nullable: true,
              enum: ['IMAGE', 'TEXT', 'SCREEN_CROP'],
            },
            status: {
              type: 'string',
              enum: ['QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED'],
            },
            aiGenerationScore: {
              type: 'number',
              nullable: true,
              minimum: 0,
              maximum: 100,
              description: '레거시 CuRe 표시 점수. 피싱 위험 점수 아님.',
            },
            aiRiskLevel: {
              type: 'string',
              nullable: true,
              description: '레거시 모델 값. 공통 riskLevel과 별개.',
            },
            reasons: {
              type: 'array',
              nullable: true,
              items: {
                type: 'object',
                properties: { description: { type: 'string' } },
              },
              description: '레거시 IMAGE 근거',
            },
            modelVersion: { type: 'string', nullable: true },
            errorCode: { type: 'string', nullable: true },
            imageResultStatus: {
              type: 'string',
              nullable: true,
              enum: ['COMPLETED', 'PARTIAL_FAILED', 'FAILED'],
            },
            modelResults: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['GENERATION', 'MANIPULATION'],
                  },
                  status: { type: 'string', enum: ['SUCCEEDED', 'FAILED'] },
                  displayScore: {
                    type: 'integer',
                    nullable: true,
                    minimum: 0,
                    maximum: 100,
                  },
                  decision: {
                    type: 'string',
                    nullable: true,
                    enum: [
                      'AI_GENERATED_SUSPECTED',
                      'NO_CLEAR_GENERATION_SIGNAL',
                      'MANIPULATION_SUSPECTED',
                      'NO_CLEAR_MANIPULATION_SIGNAL',
                      'INCONCLUSIVE',
                    ],
                  },
                  reasons: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { description: { type: 'string' } },
                    },
                  },
                  limitations: { type: 'array', items: { type: 'string' } },
                  modelName: { type: 'string' },
                  modelVersion: { type: 'string' },
                  policyVersion: { type: 'string' },
                  errorCode: { type: 'string', nullable: true },
                  retryable: { type: 'boolean', nullable: true },
                },
              },
            },
            result: { $ref: getSchemaPath(NormalizedAnalysisResultDto) },
            createdAt: { type: 'string', format: 'date-time' },
            completedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            updatedAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    schema: errorSchema('COMMON400'),
    description: '잘못된 UUID',
  })
  @ApiResponse({ status: 401, schema: errorSchema('AUTH401') })
  @ApiResponse({
    status: 404,
    schema: errorSchema('ANALYSIS404'),
    description: '미존재/다른 사용자/만료',
  })
  @ApiResponse({ status: 500, schema: errorSchema('COMMON500') })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('analysisId', new ParseUUIDPipe()) analysisId: string,
  ) {
    return this.service.findOne(request.user.id, analysisId);
  }

  @Post()
  @HttpCode(202)
  @UseInterceptors(UploadedImageCleanupInterceptor, FileInterceptor('file'))
  @ApiOperation({
    summary: '이미지 또는 텍스트 분석 요청 생성',
    description:
      'NODE_ENV=development에서만 인증을 우회하여 development-user로 저장합니다. production 및 그 외 환경은 JWT Bearer 필수이며 JWT sub로 저장합니다. IMAGE는 기존 multipart/form-data이며 부분 실패 202, 전체 실패/타임아웃 503입니다. TEXT 직접 입력은 application/json, 문자 캡처 OCR은 multipart/form-data의 type=TEXT, sourceType=SCREEN_CROP, file입니다. JSON TEXT는 sourceType=DIRECT 또는 생략을 지원합니다. 기본 모드는 AI 호출 없이 QUEUED/202이며 TEXT_AI_PROVIDER=http일 때 동기 AI 처리 후 202를 유지합니다. TEXT는 trim 후 5~3,000자, 미리보기 최대 200자만 보관하며 생성 후 30일 만료입니다. 원문은 저장하지 않습니다. URL은 미지원입니다.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'IMAGE 및 TEXT AI HTTP 모드 지원. TEXT 기본 모드에서는 전달 시 COMMON400. 1~128자 공백 없는 ASCII. 사용자별 키. 완료는 202 재사용, 처리 중/만료/내용 충돌은 COMMON409. 실패는 기존 오류 재사용. 새 분석에는 새 키 사용.',
  })
  @ApiResponse({
    status: 409,
    description: 'COMMON409: 처리 중, 키/내용 충돌 또는 만료된 키',
  })
  @ApiBody({
    schema: analysisRequestBody.content['multipart/form-data'].schema,
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
            type: { type: 'string', enum: ['IMAGE', 'TEXT'] },
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
            textResult: {
              type: 'object',
              nullable: true,
              description:
                'TEXT AI HTTP 모드의 text-risk-1.0 메타데이터. 원문·OCR·자유문구를 제외. riskScore는 0..1 미보정 분류 점수이며 riskLevel/phishingScore 변환 없음.',
              properties: {
                contractVersion: { type: 'string', enum: ['text-risk-1.0'] },
                status: { type: 'string', enum: ['COMPLETED'] },
                decision: {
                  type: 'string',
                  enum: ['normal', 'phishing', 'defer'],
                },
                riskScore: {
                  type: 'number',
                  nullable: true,
                  minimum: 0,
                  maximum: 1,
                },
                scoreScale: { type: 'string', enum: ['0..1'] },
                scoreMeaning: {
                  type: 'string',
                  enum: ['UNCALIBRATED_CLASSIFIER_SCORE'],
                },
                requestId: { type: 'string', format: 'uuid' },
                analysisId: { type: 'string', format: 'uuid' },
                elementId: { type: 'string', format: 'uuid' },
                sourceType: {
                  type: 'string',
                  enum: ['TEXT', 'IMAGE', 'SCREEN_CROP'],
                },
                modelName: { type: 'string' },
                modelVersion: { type: 'string' },
                policyVersion: { type: 'string' },
                quality: { type: 'object', additionalProperties: true },
                processingMs: { type: 'number', minimum: 0 },
              },
            },
            textPreview: {
              type: 'string',
              maxLength: 200,
              description:
                'TEXT 응답의 기존 미리보기. 캡처는 빈 문자열이며 OCR 원문 미포함',
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    schema: errorSchema('COMMON400'),
    description:
      'COMMON400: 잘못된 type/file/text 또는 전송 형식, TEXT의 Idempotency-Key, AI 입력 오류(400/422)',
  })
  @ApiResponse({
    status: 401,
    description: 'AUTH401: 개발 환경 외 토큰 없음/무효',
    schema: errorSchema('AUTH401'),
  })
  @ApiResponse({
    status: 413,
    description: 'COMMON413: 업로드 또는 AI 전송 파일·본문 크기 초과',
    schema: errorSchema('COMMON413'),
  })
  @ApiResponse({
    status: 415,
    description: 'COMMON415: MIME/확장자/시그니처 불일치',
    schema: errorSchema('COMMON415'),
  })
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
    @Req() request: AuthenticatedRequest,
    @Body() body: CreateAnalysisDto,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const idempotencyKey = request.get('idempotency-key');
    const contentType = request.get('content-type');
    if (body.type === 'TEXT') {
      if (body.sourceType === 'SCREEN_CROP') {
        if (
          !file ||
          body.text !== undefined ||
          !/^multipart\/form-data(?:\s*;|$)/i.test(contentType ?? '')
        )
          throw new ApiError(
            400,
            'COMMON400',
            'SCREEN_CROP은 multipart/form-data의 type=TEXT, sourceType=SCREEN_CROP, file이 필요하며 text를 함께 전달할 수 없습니다.',
          );
        return this.service.createCapture(
          request.user.id,
          file,
          idempotencyKey,
        );
      }
      // #13/#15 JSON requests without sourceType retain DIRECT semantics.
      if (file || !/^application\/json(?:\s*;|$)/i.test(contentType ?? ''))
        throw new ApiError(
          400,
          'COMMON400',
          'DIRECT 또는 sourceType 생략 TEXT는 application/json의 text만 전달해 주세요.',
        );
      return this.service.createText(
        request.user.id,
        body.text,
        idempotencyKey,
      );
    }
    if (body.sourceType !== undefined || body.text !== undefined)
      throw new ApiError(
        400,
        'COMMON400',
        'IMAGE에는 sourceType과 text를 전달할 수 없습니다.',
      );
    return this.service.create(request.user.id, file, idempotencyKey);
  }
}
