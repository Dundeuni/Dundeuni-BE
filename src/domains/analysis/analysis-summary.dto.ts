import { ApiProperty } from '@nestjs/swagger';
import { AnalysisSummaryStatus } from '@prisma/client';

class ActionGuideDto {
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
}

class DetailedReasonDto extends ActionGuideDto {
  @ApiProperty({ enum: ['GENERATION', 'MANIPULATION'] })
  type!: 'GENERATION' | 'MANIPULATION';
}

class AnalysisSummaryResultDto {
  @ApiProperty({ format: 'uuid' }) analysisId!: string;
  @ApiProperty({ enum: AnalysisSummaryStatus, nullable: true })
  summaryStatus!: AnalysisSummaryStatus | null;
  @ApiProperty({ type: String, nullable: true }) summary!: string | null;
  @ApiProperty({ type: [DetailedReasonDto], default: [], maxItems: 2 })
  detailedReasons!: DetailedReasonDto[];
  @ApiProperty({ type: [ActionGuideDto], default: [], maxItems: 3 })
  actionGuides!: ActionGuideDto[];
  @ApiProperty({ type: String, nullable: true }) reassurance!: string | null;
  @ApiProperty({ type: String, nullable: true }) summaryModel!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  summarizedAt!: string | null;
}

export class AnalysisSummaryResponseDto {
  @ApiProperty({ example: true }) isSuccess!: boolean;
  @ApiProperty({ example: 'ANALYSIS200' }) code!: string;
  @ApiProperty({ example: '이미지 분석 요약 조회에 성공했습니다.' })
  message!: string;
  @ApiProperty({ type: AnalysisSummaryResultDto })
  result!: AnalysisSummaryResultDto;
}
