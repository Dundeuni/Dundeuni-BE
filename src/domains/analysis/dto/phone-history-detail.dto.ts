import { ApiProperty } from '@nestjs/swagger';

export class PhoneHistoryDetailDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '010********',
    description:
      '기존 정책대로 지역/통신 prefix 외 숫자는 마스킹. 알 수 없는 형식은 null.',
  })
  maskedPhoneNumber!: string | null;
  @ApiProperty({
    enum: ['SAFE', 'CAUTION', 'DANGER', 'UNKNOWN'],
    nullable: true,
  })
  riskLevel!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    description: '저장된 신고 건수. 미확인은 null이며 0으로 추정하지 않습니다.',
  })
  reportCount!: number | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      '저장된 1000+ 같은 범위 건수는 true. reportCount는 하한값입니다. 출처가 불명확하면 null.',
  })
  reportCountIsRange!: boolean | null;
  @ApiProperty({
    type: [String],
    description: '저장된 판단 근거만 반환하며 전화번호 형태는 제거합니다.',
  })
  reasons!: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  analyzedAt!: string | null;
}
