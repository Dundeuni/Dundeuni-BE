import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AccessTokenGuard,
  AuthenticatedRequest,
} from '../../common/auth/access-token.guard';
import { ApiErrorFilter } from '../../common/http/api-error';
import { PhotoSelectionService } from './photo-selection.service';
import { PhotoUploadResponseDto, SelectPhotoDto } from './photo-selection.dto';
import { UploadedImageCleanupInterceptor } from './uploaded-image-cleanup.interceptor';

@Injectable()
export class PhotoSelectionGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly tokens: AccessTokenGuard,
  ) {}
  canActivate(context: ExecutionContext) {
    if (this.config.get('NODE_ENV') === 'development') {
      context.switchToHttp().getRequest<AuthenticatedRequest>().user = {
        id: 'development-user',
      };
      return true;
    }
    return this.tokens.canActivate(context);
  }
}

@ApiTags('Image selection')
@ApiBearerAuth()
@Controller('analysis/image-uploads')
@UseFilters(ApiErrorFilter)
@UseGuards(PhotoSelectionGuard)
export class PhotoSelectionController {
  constructor(private readonly service: PhotoSelectionService) {}

  @Post()
  @ApiOperation({
    summary: '사진 후보 추출 (생성·변조 분석 전)',
    description:
      'Gemini 비전 API로 캡처 이미지를 Google에 전송하여 사진 영역을 인식합니다. 메모리에 10분 보관하며 프로세스 재시작 시 소실됩니다. NODE_ENV=development에서만 임시 공용 사용자, 그 외 Bearer 필수. 빈 후보는 NO_CANDIDATES. 좌표는 EXIF 방향을 적용한 이미지 기준입니다.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({
    status: 201,
    type: PhotoUploadResponseDto,
    description:
      'uploadId, image.width/height, expiresAt, elements[{elementId,bbox}] 반환',
  })
  @UseInterceptors(UploadedImageCleanupInterceptor, FileInterceptor('file'))
  extract(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.extract(request.user.id, file);
  }

  @Get(':uploadId')
  @ApiOperation({ summary: '사진 후보 재조회' })
  @ApiResponse({ status: 200, type: PhotoUploadResponseDto })
  read(
    @Req() request: AuthenticatedRequest,
    @Param('uploadId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.read(request.user.id, id);
  }

  @Post(':uploadId/analyses')
  @HttpCode(202)
  @ApiOperation({
    summary: '선택한 원본 또는 사진 영역 분석',
    description:
      'original의 elementId이면 업로드 원본 바이트를 그대로 사용하고, elements의 elementId이면 저장 좌표로 crop 후 기존 CuRe/FUSED 및 요약 경로 호출. 성공하면 업로드 삭제. 결과는 기존 GET /api/analysis/{analysisId}로 조회하며 photoSelection에 출처 좌표가 저장됩니다.',
  })
  @ApiBody({ type: SelectPhotoDto })
  @ApiResponse({ status: 202, description: '기존 ANALYSIS202 응답' })
  select(
    @Req() request: AuthenticatedRequest,
    @Param('uploadId', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    body: SelectPhotoDto,
  ) {
    return this.service.select(request.user.id, id, body.elementId);
  }

  @Delete(':uploadId')
  @ApiOperation({ summary: '선택 취소 및 임시 이미지 삭제' })
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('uploadId', new ParseUUIDPipe()) id: string,
  ) {
    return this.service.cancel(request.user.id, id);
  }
}
