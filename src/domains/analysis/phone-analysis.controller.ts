import {
  Body,
  Controller,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AccessTokenGuard,
  AuthenticatedRequest,
} from '../../common/auth/access-token.guard';
import { ApiErrorFilter } from '../../common/http/api-error';
import {
  PhoneAnalysisRequestDto,
  PhoneAnalysisResponseDto,
} from './phone-analysis.dto';
import { PhoneAnalysisService } from './phone-analysis.service';

@ApiTags('Analysis')
@ApiBearerAuth()
@Controller('analyses/phone')
@UseGuards(AccessTokenGuard)
@UseFilters(ApiErrorFilter)
export class PhoneAnalysisController {
  constructor(private readonly service: PhoneAnalysisService) {}
  @Post()
  @ApiOperation({
    summary: '[PB-04] 전화번호 동기 분석 요청',
    description:
      'JWT 필수. APICK 조회 후 마스킹한 번호와 결과 저장. 분석 ID는 기존 UUID 형식. 상세 조회는 PB-05 범위.',
  })
  @ApiBody({ type: PhoneAnalysisRequestDto })
  @ApiResponse({
    status: 201,
    type: PhoneAnalysisResponseDto,
    example: {
      analysisId: 'd734f69e-ce2e-4914-8a2e-230713d37c96',
      status: 'COMPLETED',
    },
  })
  @ApiResponse({
    status: 400,
    description: 'INVALID_PHONE_NUMBER: 문자열 필수, 한국 번호 형식 오류',
  })
  @ApiResponse({
    status: 401,
    description: 'AUTH401: JWT 누락/만료/무효 (기존 인증 코드)',
  })
  @ApiResponse({
    status: 503,
    description:
      'EXTERNAL_API_UNAVAILABLE / APICK_QUOTA_EXCEEDED / APICK_AUTHENTICATION_FAILED',
  })
  @ApiResponse({
    status: 500,
    description:
      'APICK_CONFIGURATION_ERROR: APICK_AUTH_KEY 미설정 / INTERNAL_SERVER_ERROR: DB 또는 내부 오류',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: PhoneAnalysisRequestDto,
  ) {
    return this.service.create(request.user.id, body?.phoneNumber);
  }
}
