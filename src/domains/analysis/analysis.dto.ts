import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsEnum } from 'class-validator';
import { AnalysisType } from '@prisma/client';

export class CreateAnalysisDto {
  @ApiProperty({
    enum: AnalysisType,
    description: 'P0: IMAGE/TEXT/URL. 현재 IMAGE만 지원합니다.',
    example: 'IMAGE',
  })
  @IsEnum(AnalysisType, {
    message: 'type은 IMAGE, TEXT, URL 중 하나여야 합니다.',
  })
  @Equals(AnalysisType.IMAGE, {
    message:
      '현재 IMAGE 분석만 지원합니다. TEXT/URL 분석은 아직 지원하지 않습니다.',
  })
  type!: AnalysisType;
}

// 신규 공개 결과 계약 준비. 현재 POST 응답에는 아직 추가하지 않는다.
export {
  ImageModelPublicResultDto,
  ImageModelsPublicResultDto,
} from './image-analysis-v1.dto';
