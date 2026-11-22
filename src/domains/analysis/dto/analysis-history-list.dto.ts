import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AnalysisStatus, AnalysisType } from '@prisma/client';

export class AnalysisHistoryQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 2147483647 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  page = 1;

  @ApiPropertyOptional({
    default: 20,
    minimum: 1,
    maximum: 100,
    description: '페이지 크기이며 요금제별 기록 개수 제한이 아닙니다.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class AnalysisHistoryItemDto {
  @ApiProperty({ format: 'uuid' }) analysisId!: string;
  @ApiProperty({ enum: AnalysisType }) type!: AnalysisType;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'PHONE은 기존 마스킹 정책을 적용한 번호를 반환합니다. 저장된 대상 요약이 없으면 null.',
  })
  targetSummary!: string | null;
  @ApiProperty({ enum: AnalysisStatus }) status!: AnalysisStatus;
  @ApiProperty({ type: String, nullable: true }) aiRiskLevel!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AnalysisHistoryListDto {
  @ApiProperty({ type: [AnalysisHistoryItemDto] })
  items!: AnalysisHistoryItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() hasNext!: boolean;
}

export class AnalysisHistoryListResponseDto {
  @ApiProperty({ example: true }) isSuccess!: boolean;
  @ApiProperty({ example: 'ANALYSIS200' }) code!: string;
  @ApiProperty({ example: '검사 기록 목록 조회에 성공했습니다.' })
  message!: string;
  @ApiProperty({ type: AnalysisHistoryListDto })
  result!: AnalysisHistoryListDto;
}
