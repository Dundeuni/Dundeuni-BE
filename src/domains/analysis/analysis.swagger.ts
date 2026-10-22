import { OpenAPIObject, RequestBodyObject } from '@nestjs/swagger';

export const analysisRequestBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['type', 'file'],
        properties: {
          type: {
            type: 'string',
            enum: ['IMAGE', 'TEXT'],
            default: 'IMAGE',
            description:
              'IMAGE: sourceType 없이 생성·변조 분석. TEXT: sourceType=SCREEN_CROP을 명시한 문자 캡처 OCR·피싱 분석.',
          },
          sourceType: {
            type: 'string',
            enum: ['SCREEN_CROP'],
            description:
              'type=TEXT일 때 필수. IMAGE는 빈 값 전송 없이 필드 자체를 생략하세요.',
          },
          file: {
            type: 'string',
            format: 'binary',
            description: 'JPEG/PNG 이미지 파일',
          },
        },
      },
    },
    'application/json': {
      schema: {
        type: 'object',
        required: ['type', 'text'],
        properties: {
          type: { type: 'string', enum: ['TEXT'], default: 'TEXT' },
          sourceType: {
            type: 'string',
            enum: ['DIRECT'],
            description:
              '생략 시 기존 JSON TEXT 요청과 동일하게 DIRECT. 내부 AI에는 TEXT로 매핑.',
          },
          text: {
            type: 'string',
            minLength: 5,
            maxLength: 3000,
            example: '이 메시지가 의심스러워요.',
          },
        },
      },
    },
  },
} satisfies RequestBodyObject;

/** Nest ApiBody repeats one schema for every consumed media type. Supply each separately. */
export function configureAnalysisSwagger(
  document: OpenAPIObject,
): OpenAPIObject {
  const operation = document.paths['/api/analysis']?.post;
  if (operation) operation.requestBody = analysisRequestBody;
  return document;
}
