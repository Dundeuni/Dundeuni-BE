import { ImageHistorySummaryDto } from './image-history-summary.dto';
import { ApiProperty } from '@nestjs/swagger';
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
    type: ImageHistorySummaryDto,
    nullable: true,
    description:
      'IMAGE는 저장된 Gemini 요약과 상태·모델·시각을 반환합니다. 다른 유형 상세는 후속 구현 전까지 null입니다.',
  })
  detail!: ImageHistorySummaryDto | Record<string, unknown> | null;
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
