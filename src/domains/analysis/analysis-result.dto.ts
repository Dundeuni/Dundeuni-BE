import { ApiProperty } from '@nestjs/swagger';
import {
  ImageModelsPublicResultDto,
  ImageOverallResult,
} from './image-analysis-v1.dto';

export class AnalysisOverallResultDto implements ImageOverallResult {
  @ApiProperty({
    enum: [
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      'INCONCLUSIVE',
      'NO_CLEAR_SIGNAL',
    ],
  })
  decision!: ImageOverallResult['decision'];
  @ApiProperty() decisionLabel!: string;
  @ApiProperty({ example: 'image-overall-v1' })
  policyVersion!: 'image-overall-v1';
  @ApiProperty({ type: [String] })
  suspectedKinds!: ImageOverallResult['suspectedKinds'];
  @ApiProperty({ type: [String] })
  uncertainKinds!: ImageOverallResult['uncertainKinds'];
}
export class AnalysisResultDto {
  @ApiProperty({ format: 'uuid' }) analysisId!: string;
  @ApiProperty({ enum: ['IMAGE', 'TEXT', 'URL'] }) type!: string;
  @ApiProperty({ enum: ['QUEUED', 'ANALYZING', 'COMPLETED', 'FAILED'] })
  status!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'AI 생성 신호의 기존 표시 점수. 사기 확률이 아니며 null은 0점이 아닙니다.',
  })
  aiGenerationScore!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '기존 Provider 위험도 필드. 사기 확률이나 overallResult와 동일하지 않으며 정책 미확정 시 null. null을 안전으로 표시하지 않습니다.',
  })
  aiRiskLevel!: string | null;
  @ApiProperty({
    type: 'array',
    nullable: true,
    items: { type: 'object', properties: { description: { type: 'string' } } },
  })
  reasons!: { description: string }[] | null;
  @ApiProperty({ type: String, nullable: true }) modelVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({
    type: ImageModelsPublicResultDto,
    nullable: true,
    description:
      '저장된 모델별 결과. 모델 이름은 modelName. 모델 결과 미저장 시 null.',
  })
  models!: ImageModelsPublicResultDto | null;
  @ApiProperty({
    type: AnalysisOverallResultDto,
    description:
      '저장된 모델 결과로 재계산. 모델 누락 시 INCONCLUSIVE. 점수 합산 없음.',
  })
  overallResult!: AnalysisOverallResultDto;
  @ApiProperty({
    type: [String],
    description:
      '종합 판정별 대응 안내와 모델 실패 안내. 간결한 한국어 문장. Gemini 요약 상태와 독립적입니다.',
  })
  guides!: string[];
}
export class AnalysisResultResponseDto {
  @ApiProperty({ example: true }) isSuccess!: boolean;
  @ApiProperty({ example: 'ANALYSIS200' }) code!: string;
  @ApiProperty({ example: '분석 결과 조회에 성공했습니다.' }) message!: string;
  @ApiProperty({ type: AnalysisResultDto }) result!: AnalysisResultDto;
}
