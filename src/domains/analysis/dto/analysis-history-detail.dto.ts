import { PhoneHistoryDetailDto } from './phone-history-detail.dto';
import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { AnalysisStatus, AnalysisType } from '@prisma/client';

export class AnalysisHistoryReasonDto {
  @ApiProperty() description!: string;
}

export class AnalysisHistoryDetailDto {
  @ApiProperty({ format: 'uuid' }) analysisId!: string;
  @ApiProperty({ enum: AnalysisType }) type!: AnalysisType;
  @ApiProperty({ enum: AnalysisStatus }) status!: AnalysisStatus;
  @ApiProperty({ type: Number, nullable: true }) aiGenerationScore!:
    number | null;
  @ApiProperty({ type: String, nullable: true }) aiRiskLevel!: string | null;
  @ApiProperty({ type: [AnalysisHistoryReasonDto], nullable: true }) reasons!:
    AnalysisHistoryReasonDto[] | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;
  @ApiProperty({
    oneOf: [{ $ref: getSchemaPath(PhoneHistoryDetailDto) }],
    nullable: true,
    description:
      'PHONE은 저장된 마스킹 번호·위험도·신고 건수·근거·검사 시각을 제공합니다. 다른 유형은 null.',
  })
  detail!: PhoneHistoryDetailDto | null;
}

export class AnalysisHistoryDetailResponseDto {
  @ApiProperty({ example: true }) isSuccess!: boolean;
  @ApiProperty({ example: 'ANALYSIS200' }) code!: string;
  @ApiProperty({ example: '검사 기록 상세 조회에 성공했습니다.' })
  message!: string;
  @ApiProperty({ type: AnalysisHistoryDetailDto })
  result!: AnalysisHistoryDetailDto;
}

export class AnalysisHistoryDeleteResultDto {
  @ApiProperty({ minimum: 0 }) deletedCount!: number;
}

export class AnalysisHistoryDeleteResponseDto {
  @ApiProperty({ example: true }) isSuccess!: boolean;
  @ApiProperty({ example: 'ANALYSIS200' }) code!: string;
  @ApiProperty({ example: '검사 기록 삭제에 성공했습니다.' }) message!: string;
  @ApiProperty({ type: AnalysisHistoryDeleteResultDto })
  result!: AnalysisHistoryDeleteResultDto;
}

export class AnalysisHistoryErrorResponseDto {
  @ApiProperty({ example: false }) isSuccess!: boolean;
  @ApiProperty({ example: 'COMMON404' }) code!: string;
  @ApiProperty() message!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    nullable: true,
    example: null,
  })
  result!: null;
}
