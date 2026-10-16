import type { AiImageAnalysisRequestV1 } from './image-analysis.service';
export function validateImageAnalysisRequest(
  request: AiImageAnalysisRequestV1,
): void {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const v4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(request.analysisId) ||
    !uuid.test(request.elementId) ||
    !v4.test(request.requestId) ||
    !['IMAGE', 'SCREEN_CROP'].includes(request.sourceType) ||
    !['ALL', 'GENERATION', 'MANIPULATION'].includes(request.models) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(
      request.deadlineAt,
    ) ||
    !Number.isFinite(Date.parse(request.deadlineAt)) ||
    Date.parse(request.deadlineAt) <= Date.now()
  )
    throw new Error('Invalid v0.2 request context');
}
