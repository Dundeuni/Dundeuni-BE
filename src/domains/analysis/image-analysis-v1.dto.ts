import { ApiProperty } from '@nestjs/swagger';

/** BE→AI v1 wire contract. 미확정 값/중첩 구조는 추정하지 않는다. */
export type AiImageResultStatus = 'COMPLETED' | 'PARTIAL_FAILED' | 'FAILED';
export type AiModelStatus = 'SUCCEEDED' | 'FAILED';
export type AiModelDecision =
  | 'AI_GENERATED_SUSPECTED'
  | 'NO_CLEAR_GENERATION_SIGNAL'
  | 'MANIPULATION_SUSPECTED'
  | 'NO_CLEAR_MANIPULATION_SIGNAL'
  | 'INCONCLUSIVE';

// TODO: 원문에서 discriminator/PNG 필드명/크기/좌표/인코딩 규칙 확인 후 구체화.
export type AiPngBase64Localization = Readonly<Record<string, unknown>>;
export interface AiModelError {
  code: string;
  // TODO: message, retryable 등 실제 필드명과 필수 여부 확인.
  [key: string]: unknown;
}
export interface AiModelResultV1 {
  status: AiModelStatus;
  modelName: string;
  modelVersion: string;
  policyVersion: string;
  rawScore: unknown; // TODO: 숫자/객체/null의 실제 계약 확인. 저장·공개 금지.
  displayScore: number | null;
  decision: AiModelDecision | null;
  reasons: unknown[]; // TODO: 원문에서 원소 구조 확인.
  limitations: unknown[]; // TODO: 원문에서 원소 구조 확인.
  localization: AiPngBase64Localization | null;
  errorCode: string | null;
  error: AiModelError | null;
}
export interface AiImageAnalysisResponseV1 {
  contractVersion: string; // TODO: 정확한 v1 리터럴 확인.
  requestId: string;
  analysisId: string;
  elementId: unknown; // TODO: 타입/null 허용 확인.
  sourceType: unknown; // TODO: enum 확인.
  requestedModels: unknown[]; // TODO: 모델 선택자와 generation/manipulation 대응 확인.
  status: AiImageResultStatus;
  analysisImage: unknown; // TODO: 원문 확인. 영구 저장 금지.
  generation: AiModelResultV1 | null;
  manipulation: AiModelResultV1 | null;
  completedAt: string;
}

/** BE가 사용하는 안전한 공개/저장 projection. AI wire DTO와 별개이며 어댑터의 명시적 변환이 필요하다. */
export class ImageModelPublicResultDto {
  @ApiProperty({ enum: ['SUCCEEDED', 'FAILED'] })
  status!: AiModelStatus;
  @ApiProperty() modelName!: string;
  @ApiProperty() modelVersion!: string;
  @ApiProperty() policyVersion!: string;
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 100,
    nullable: true,
    description: '0~100 정수 또는 null',
  })
  displayScore!: number | null;
  @ApiProperty({
    nullable: true,
    enum: [
      'AI_GENERATED_SUSPECTED',
      'NO_CLEAR_GENERATION_SIGNAL',
      'MANIPULATION_SUSPECTED',
      'NO_CLEAR_MANIPULATION_SIGNAL',
      'INCONCLUSIVE',
    ],
  })
  decision!: AiModelDecision | null;
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      required: ['description'],
      properties: { description: { type: 'string' } },
    },
  })
  reasons!: { description: string }[];
  @ApiProperty({ type: [String] }) limitations!: string[];
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: '미확정이면 null, 재시도 실행 기능 아님',
  })
  retryable!: boolean | null;
}
export class ImageModelsPublicResultDto {
  @ApiProperty({ enum: ['COMPLETED', 'PARTIAL_FAILED', 'FAILED'] })
  status!: AiImageResultStatus;
  @ApiProperty({ type: ImageModelPublicResultDto, nullable: true })
  generation!: ImageModelPublicResultDto | null;
  @ApiProperty({ type: ImageModelPublicResultDto, nullable: true })
  manipulation!: ImageModelPublicResultDto | null;
}
