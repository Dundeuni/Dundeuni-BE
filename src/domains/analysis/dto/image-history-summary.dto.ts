import { ApiProperty } from '@nestjs/swagger';
import { AnalysisSummaryStatus } from '@prisma/client';

/** The persisted summary only. Scores, risk and inspection time remain in the common history fields. */
export class ImageHistorySummaryDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'COMPLETED인 경우 DB에 저장된 Gemini 요약본. 조회 시 생성하지 않습니다.',
  })
  summary!: string | null;

  @ApiProperty({
    enum: AnalysisSummaryStatus,
    nullable: true,
    description:
      'null: 미등록/미생성. PENDING/FAILED는 요약 내용을 반환하지 않습니다.',
  })
  summaryStatus!: AnalysisSummaryStatus | null;

  @ApiProperty({ type: String, nullable: true })
  summaryModel!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  summarizedAt!: string | null;
}
