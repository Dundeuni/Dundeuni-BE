import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
export const textWire = (
  analysisId: string,
  elementId: string,
  sourceType: 'TEXT' | 'IMAGE' | 'SCREEN_CROP' = 'TEXT',
) => ({
  contractVersion: 'text-risk-1.0',
  requestId: randomUUID(),
  analysisId,
  elementId,
  sourceType,
  status: 'COMPLETED',
  decision: 'phishing',
  riskScore: 0.82,
  scoreScale: '0..1',
  scoreMeaning: 'UNCALIBRATED_CLASSIFIER_SCORE',
  modelName: 'ax',
  modelVersion: 'fixture-v1',
  policyVersion: 'fixture-policy',
  text: 'private original echo',
  quality: {
    needsReview: false,
    reasonCodes: [],
    ocrUsed: sourceType !== 'TEXT',
    poorOcrConfidence: false,
    layoutUncertain: false,
    contextDisagreement: false,
  },
  evidence: ['private original evidence'],
  limitations: ['private original limitation'],
  processingMs: 12,
});

export const textTestSecret = 'text-fixture-secret';

export function textTestAuthorization(
  secret = textTestSecret,
  sub = 'development-user',
) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const claims = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const body = `${header}.${claims}`;
  return `Bearer ${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
