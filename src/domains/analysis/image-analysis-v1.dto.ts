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

export interface AiPngBase64Localization {
  format: 'PNG_BASE64';
  kind: 'MANIPULATION_HEATMAP';
  mimeType: 'image/png';
  data: string;
  imageSize: { width: number; height: number };
  mapSize: { width: number; height: number };
  coordinateSpace: 'ANALYSIS_IMAGE';
}
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

export interface ImageOverallResult {
  decision:
    'GENERATION_OR_MANIPULATION_SUSPECTED' | 'INCONCLUSIVE' | 'NO_CLEAR_SIGNAL';
  decisionLabel: string;
  policyVersion: 'image-overall-v1';
  suspectedKinds: ('generation' | 'manipulation')[];
  uncertainKinds: ('generation' | 'manipulation')[];
}
/** v0.2 확정된 필드를 기존 v1 타입에서 확장. legacy validator 사용자는 그대로 유지한다. */
export interface AiModelResultV02 extends Omit<
  AiModelResultV1,
  'rawScore' | 'reasons' | 'modelName' | 'limitations' | 'error'
> {
  modelName?: string;
  rawScore: { score: number } | null;
  reasons: string[];
  limitations: string[];
  error: { code: string; message: string; retryable: boolean } | null;
  decisionLabel: string | null;
}
export interface AiAnalysisImageV02 {
  inputSha256: string;
  width: number;
  height: number;
  normalizationVersion: string;
}
export interface AiImageAnalysisResponseV02 extends Omit<
  AiImageAnalysisResponseV1,
  | 'generation'
  | 'manipulation'
  | 'requestedModels'
  | 'analysisImage'
  | 'elementId'
  | 'sourceType'
> {
  contractVersion: '1.0';
  elementId: string;
  sourceType: 'IMAGE' | 'SCREEN_CROP';
  requestedModels: ('generation' | 'manipulation')[];
  analysisImage: AiAnalysisImageV02;
  generation: AiModelResultV02 | null;
  manipulation: AiModelResultV02 | null;
  overallResult: ImageOverallResult;
}
