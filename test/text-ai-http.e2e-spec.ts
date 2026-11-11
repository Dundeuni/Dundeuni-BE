import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { HttpTextAnalysisProvider } from '../src/domains/analysis/http-text-analysis.provider';
import {
  validateTextRiskResponse,
  storedTextRiskResult,
} from '../src/domains/analysis/text-risk.dto';

import { textWire } from './fixtures/text-risk';
const config = () =>
  new ConfigService({
    AI_SERVICE_BASE_URL: 'http://127.0.0.1:9',
    AI_SERVICE_TOKEN: 'test-only-token',
    TEXT_AI_SERVICE_TOKEN: 'test-only-token',
  });
const input = () => ({
  analysisId: randomUUID(),
  elementId: randomUUID(),
  userId: 'private-user',
  text: '검증용 합성 텍스트',
});

describe('deployed TEXT/OCR HTTP contract with mocked transport', () => {
  afterEach(() => jest.restoreAllMocks());
  it('sends only OpenAPI-supported JSON fields, Bearer auth, and exact endpoint', async () => {
    const ctx = input();
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(textWire(ctx.analysisId, ctx.elementId)),
      );
    const value = await new HttpTextAnalysisProvider(config()).analyze(
      ctx,
      new AbortController().signal,
    );
    expect(transport.mock.calls[0][0].toString()).toBe(
      'http://127.0.0.1:9/internal/v1/text-analyses',
    );
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({
      text: ctx.text,
      analysisId: ctx.analysisId,
      elementId: ctx.elementId,
    });
    expect(transport.mock.calls[0][1]!.headers).toMatchObject({
      Authorization: 'Bearer test-only-token',
    });
    const dto = validateTextRiskResponse(value, { ...ctx, sourceType: 'TEXT' });
    expect(dto.riskScore).toBe(0.82);
    expect(dto).not.toHaveProperty('phishingScore');
    expect(dto).not.toHaveProperty('riskLevel');
    const stored = storedTextRiskResult(dto);
    expect(JSON.stringify(stored)).not.toContain('private original');
    expect(stored).not.toHaveProperty('text');
    expect(stored).not.toHaveProperty('evidence');
  });
  it('sends OCR multipart with no models/deadlineAt/schemaVersion or original filename', async () => {
    const ctx = input();
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(textWire(ctx.analysisId, ctx.elementId, 'SCREEN_CROP')),
      );
    await new HttpTextAnalysisProvider(config()).analyzeImage(
      {
        buffer: Buffer.from('synthetic image'),
        mimetype: 'image/png',
      } as Express.Multer.File,
      {
        analysisId: ctx.analysisId,
        elementId: ctx.elementId,
        sourceType: 'SCREEN_CROP',
      },
      new AbortController().signal,
    );
    const form = transport.mock.calls[0][1]!.body as FormData;
    expect([...form.keys()]).toEqual([
      'file',
      'analysisId',
      'elementId',
      'sourceType',
    ]);
    expect((form.get('file') as File).name).toBe('capture.png');
  });
  it.each([400, 401, 403, 422, 500, 503])(
    'sanitizes HTTP %i without retries',
    async (status) => {
      const transport = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('secret trace test-only-token', { status }),
        );
      await expect(
        new HttpTextAnalysisProvider(config()).analyze(
          input(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        status: 503,
        failureKind: 'UPSTREAM',
        response: { code: 'ANALYSIS503', result: null },
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('distinguishes network errors from invalid JSON and omits raw upstream details', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('private network'));
    await expect(
      new HttpTextAnalysisProvider(config()).analyze(
        input(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failureKind: 'NETWORK' });
    transport.mockResolvedValueOnce(new Response('{broken secret trace'));
    await expect(
      new HttpTextAnalysisProvider(config()).analyze(
        input(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failureKind: 'INVALID_RESPONSE' });
  });
  it.each([
    'score',
    'scale',
    'meaning',
    'context',
    'quality',
    'status',
    'contract',
    'missing',
  ])('rejects incompatible %s', (kind) => {
    const ctx = input();
    const wire: any = textWire(ctx.analysisId, ctx.elementId);
    if (kind === 'score') wire.riskScore = 82;
    if (kind === 'scale') wire.scoreScale = '0..100';
    if (kind === 'meaning') wire.scoreMeaning = 'PROBABILITY';
    if (kind === 'context') wire.analysisId = randomUUID();
    if (kind === 'quality') wire.quality.needsReview = 'false';
    if (kind === 'status') wire.status = 'SUCCEEDED';
    if (kind === 'contract') wire.contractVersion = 'text-risk-v0.1';
    if (kind === 'missing') delete wire.evidence;
    expect(() =>
      validateTextRiskResponse(wire, { ...ctx, sourceType: 'TEXT' }),
    ).toThrow();
  });
  it('does not invent optional server defaults when absent from the wire', () => {
    const ctx = input();
    const wire: any = textWire(ctx.analysisId, ctx.elementId);
    delete wire.contractVersion;
    delete wire.status;
    const dto = storedTextRiskResult(
      validateTextRiskResponse(wire, { ...ctx, sourceType: 'TEXT' }),
    );
    expect(dto).not.toHaveProperty('status');
    expect(dto).not.toHaveProperty('contractVersion');
  });
  it('keeps defer and null rather than creating normal/zero or thresholds', () => {
    const ctx = input();
    const wire: any = textWire(ctx.analysisId, ctx.elementId);
    wire.decision = 'defer';
    wire.riskScore = null;
    wire.quality.needsReview = true;
    expect(
      validateTextRiskResponse(wire, { ...ctx, sourceType: 'TEXT' }),
    ).toMatchObject({
      decision: 'defer',
      riskScore: null,
      quality: { needsReview: true },
    });
  });
});
