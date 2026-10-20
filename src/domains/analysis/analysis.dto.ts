import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, ValidateBy, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { AnalysisType } from '@prisma/client';
import { normalizeTextInput } from './text-analysis.input';

export class CreateAnalysisDto {
  @ApiProperty({
    enum: ['IMAGE', 'TEXT'],
    description: 'IMAGE는 multipart/form-data, TEXT는 application/json.',
    example: 'IMAGE',
  })
  @IsIn([AnalysisType.IMAGE, AnalysisType.TEXT], {
    message: '현재 IMAGE/TEXT 분석만 지원합니다.',
  })
  type!: AnalysisType;

  @ApiProperty({
    required: false,
    minLength: 5,
    maxLength: 3000,
    description:
      'TEXT 필수. 앞뒤 공백 제거 후 Unicode 코드 포인트 기준 5~3,000자. 원문 미보관.',
  })
  @ValidateIf((body: CreateAnalysisDto) => body.type === AnalysisType.TEXT)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'text는 필수 문자열입니다.' })
  @ValidateBy({
    name: 'textInput',
    validator: {
      validate(value: unknown) {
        try {
          normalizeTextInput(value);
          return true;
        } catch {
          return false;
        }
      },
      defaultMessage: () => 'text는 앞뒤 공백 제거 후 5~3,000자여야 합니다.',
    },
  })
  text?: string;
}

// 신규 공개 결과 계약 준비. 현재 POST 응답에는 아직 추가하지 않는다.
export {
  ImageModelPublicResultDto,
  ImageModelsPublicResultDto,
} from './image-analysis-v1.dto';
