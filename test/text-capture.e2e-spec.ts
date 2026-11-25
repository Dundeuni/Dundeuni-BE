import { randomUUID, createHmac } from 'node:crypto';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Analysis, Prisma } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { TextAiWorkflowService } from '../src/domains/analysis/text-ai-workflow.service';
import { textWire } from './fixtures/text-risk';

describe('TEXT direct and screenshot→OCR public workflow', () => {
  let app: INestApplication;
  let rows: Map<string, Analysis>;
  let capture: jest.SpyInstance;
  let transport: jest.SpyInstance;
  let image: Buffer;
  const imageProvider = { analyze: jest.fn() };
  const settings: Record<string, string> = {
    NODE_ENV: 'development',
    JWT_ACCESS_SECRET: 'capture-test-secret',
    TEXT_AI_PROVIDER: 'http',
    AI_PROVIDER: 'unavailable',
    AI_SERVICE_BASE_URL: 'http://127.0.0.1:9',
    TEXT_AI_SERVICE_TOKEN: 'test-only-token',
    ANALYSIS_MAX_FILE_BYTES: '100000',
    ANALYSIS_RETENTION_SECONDS: '2592000',
    AI_REQUEST_TIMEOUT_MS: '1000',
  };
  const db = {
    analysis: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  beforeAll(async () => {
    image = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: (name: string) => settings[name] })
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue(imageProvider)
      .overrideProvider(AnalysisUsageService)
      .useValue({ reserveAiUsage: jest.fn(), releaseAiUsage: jest.fn() })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    capture = jest.spyOn(module.get(TextAiWorkflowService), 'createCapture');
    transport = jest.spyOn(globalThis, 'fetch');
  });
  beforeEach(() => {
    rows = new Map();
    jest.clearAllMocks();
    settings.NODE_ENV = 'development';
    settings.TEXT_AI_PROVIDER = 'http';
    settings.AI_REQUEST_TIMEOUT_MS = '1000';
    db.analysis.create.mockImplementation(async ({ data }) => {
      if (
        data.idempotencyKey &&
        [...rows.values()].some(
          (r) =>
            r.userId === data.userId &&
            r.idempotencyKey === data.idempotencyKey,
        )
      )
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        });
      const row: Analysis = {
        id: randomUUID(),
        status: 'QUEUED',
        aiGenerationScore: null,
        aiRiskLevel: null,
        reasons: null,
        modelVersion: null,
        errorCode: null,
        completedAt: null,
        summary: null,
        summaryStatus: null,
        summaryModel: null,
        summarizedAt: null,
        imageResultStatus: null,
        textResult: null,
        textPreview: null,
        idempotencyKey: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      rows.set(row.id, row);
      return row;
    });
    db.analysis.update.mockImplementation(async ({ where, data }) => {
      const row = rows.get(where.id)!;
      Object.assign(row, data);
      return row;
    });
    db.analysis.findUnique.mockImplementation(
      async ({ where }) =>
        [...rows.values()].find(
          (r) =>
            r.userId === where.userId_idempotencyKey.userId &&
            r.idempotencyKey === where.userId_idempotencyKey.idempotencyKey,
        ) ?? null,
    );
    db.analysis.findFirst.mockImplementation(async ({ where }) => {
      const row = rows.get(where.id);
      return row &&
        row.userId === where.userId &&
        row.expiresAt > where.expiresAt.gt
        ? { ...row, modelResults: [] }
        : null;
    });
    transport.mockImplementation(async (_url, options: RequestInit) => {
      if (options.body instanceof FormData)
        return Response.json({
          ...textWire(
            String(options.body.get('analysisId')),
            String(options.body.get('elementId')),
            'SCREEN_CROP',
          ),
          text: 'private original 010-1234-5678, (02) 123-4567, +82 10 1234 5678',
        });
      const body = JSON.parse(options.body as string);
      return Response.json(textWire(body.analysisId, body.elementId));
    });
  });
  afterAll(async () => {
    transport.mockRestore();
    capture.mockRestore();
    await app.close();
  });
  const upload = (key?: string, bytes?: Buffer, filename = 'message.png') => {
    const call = request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .field('type', 'TEXT')
      .field('sourceType', 'SCREEN_CROP');
    if (key) call.set('Idempotency-Key', key);
    return call.attach('file', bytes ?? image, filename);
  };
  const jwt = (sub: string) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    return `${header}.${payload}.${createHmac('sha256', settings.JWT_ACCESS_SECRET).update(`${header}.${payload}`).digest('base64url')}`;
  };
  it.each(['IMAGE', 'TEXT'])(
    'blocks unauthenticated %s requests outside development before AI',
    async (type) => {
      settings.NODE_ENV = 'production';
      await request(app.getHttpServer())
        .post('/api/analysis')
        .send({ type, text: '검증용 텍스트입니다.' })
        .expect(401);
      expect(transport).not.toHaveBeenCalled();
      expect(imageProvider.analyze).not.toHaveBeenCalled();
    },
  );
  it('requires JWT for direct and OCR requests in development', async () => {
    await request(app.getHttpServer())
      .post('/api/analysis')
      .send({ type: 'TEXT', text: '검증용 텍스트입니다.' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/analysis')
      .field('type', 'TEXT')
      .field('sourceType', 'SCREEN_CROP')
      .attach('file', image, 'capture.png')
      .expect(401);
    await upload().set('Authorization', 'Bearer invalid').expect(401);
    expect(transport).not.toHaveBeenCalled();
    expect(db.analysis.create).not.toHaveBeenCalled();
  });

  it('persists authenticated OCR metadata and retrieves it by analysisId and owner', async () => {
    settings.NODE_ENV = 'production';
    const response = await upload()
      .set('Authorization', `Bearer ${jwt('alice')}`)
      .expect(202);
    const id = response.body.result.analysisId;
    const repository = app.get(AnalysisRepository);
    const saved = await repository.findActiveTextForUser(id, 'alice');
    expect(saved).toMatchObject({
      id,
      userId: 'alice',
      textResult: response.body.result.textResult,
    });
    expect(saved!.textResult).toMatchObject({
      sourceType: 'SCREEN_CROP',
      quality: { ocrUsed: true },
    });
    expect(await repository.findActiveTextForUser(id, 'bob')).toBeNull();
    rows.get(id)!.expiresAt = new Date(0);
    expect(await repository.findActiveTextForUser(id, 'alice')).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('uses a supplied JWT subject in development instead of the shared identity', async () => {
    const response = await upload()
      .set('Authorization', `Bearer ${jwt('alice')}`)
      .expect(202);
    expect(rows.get(response.body.result.analysisId)!.userId).toBe('alice');
  });
  it('sends direct text as JSON to the same text/OCR server without image inference', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .send({
        type: 'TEXT',
        sourceType: 'DIRECT',
        text:
          '직접 입력한 합성 문자입니다. ' +
          '가'.repeat(200) +
          ' 031-123-4567 070-1234-5678',
      })
      .expect(202);
    expect(transport.mock.calls[0][0].toString()).toBe(
      'http://127.0.0.1:9/internal/v1/text-analyses',
    );
    expect(response.body.result.textResult.sourceType).toBe('TEXT');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.result.textPreview).not.toContain('031');
    expect(response.body.result.extractedPhoneNumbers).toEqual([
      {
        phoneNumber: '0311234567',
        displayNumber: '031-123-4567',
        source: 'TEXT',
      },
      {
        phoneNumber: '07012345678',
        displayNumber: '070-1234-5678',
        source: 'TEXT',
      },
    ]);
    expect(imageProvider.analyze).not.toHaveBeenCalled();
  });
  it('routes explicit SCREEN_CROP through OCR and stores only metadata', async () => {
    const response = await upload().expect(202);
    const [url, options] = transport.mock.calls[0];
    expect(url.toString()).toBe(
      'http://127.0.0.1:9/internal/v1/text-analyses/image',
    );
    expect(options.headers.Authorization).toBe('Bearer test-only-token');
    expect([...options.body.keys()].sort()).toEqual([
      'analysisId',
      'elementId',
      'file',
      'sourceType',
    ]);
    expect(options.body.get('sourceType')).toBe('SCREEN_CROP');
    expect(Buffer.from(await options.body.get('file').arrayBuffer())).toEqual(
      image,
    );
    expect(response.body.result).toMatchObject({
      type: 'TEXT',
      status: 'COMPLETED',
      textPreview: '',
      textResult: { sourceType: 'SCREEN_CROP', quality: { ocrUsed: true } },
    });
    const stored = rows.get(response.body.result.analysisId)!;
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
      30 * 86400000,
    );
    expect(JSON.stringify(stored)).not.toContain('private original');
    expect(response.body.result.extractedPhoneNumbers).toEqual([
      {
        phoneNumber: '01012345678',
        displayNumber: '010-1234-5678',
        source: 'OCR',
      },
      { phoneNumber: '021234567', displayNumber: '02-123-4567', source: 'OCR' },
    ]);
    expect(response.text).not.toContain('private original');
    expect(JSON.stringify(stored)).not.toMatch(
      /01012345678|010-1234-5678|extractedPhoneNumbers/,
    );
    expect(stored.textResult).not.toHaveProperty('text');
    expect(stored.textResult).not.toHaveProperty('evidence');
    expect(imageProvider.analyze).not.toHaveBeenCalled();
    expect(
      capture.mock.calls[0][1].buffer.every((byte: number) => byte === 0),
    ).toBe(true);
  });
  it.each(['', '010-1234-5678'])(
    'returns no OCR numbers for empty or low-confidence text %j',
    async (text) => {
      transport.mockImplementationOnce(async (_url, options: RequestInit) => {
        const form = options.body as FormData;
        const wire = textWire(
          String(form.get('analysisId')),
          String(form.get('elementId')),
          'SCREEN_CROP',
        );
        return Response.json({
          ...wire,
          text,
          quality: { ...wire.quality, poorOcrConfidence: Boolean(text) },
        });
      });
      const response = await upload().expect(202);
      expect(response.body.result.extractedPhoneNumbers).toEqual([]);
    },
  );

  it('replays completed screenshots without another AI call and rejects different content with same key', async () => {
    const first = await upload('capture-1').expect(202);
    const second = await upload('capture-1').expect(202);
    expect(first.body.result.extractedPhoneNumbers).toHaveLength(2);
    expect(second.body).toEqual({
      ...first.body,
      result: { ...first.body.result, extractedPhoneNumbers: [] },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const other = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'black' },
    })
      .png()
      .toBuffer();
    await upload('capture-1', other).expect(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('separates screenshot and direct text idempotency identities', async () => {
    await upload('same-key').expect(202);
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .set('Idempotency-Key', 'same-key')
      .send({ type: 'TEXT', text: '다른 유형의 입력입니다.' })
      .expect(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupted images and wrong MIME/extension before persistence', async () => {
    await upload(undefined, Buffer.from('not an image')).expect(415);
    await upload(undefined, image.subarray(0, 12)).expect(400);
    await upload(undefined, image, 'capture.txt').expect(415);
    expect(db.analysis.create).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects missing file and ambiguous multipart text', async () => {
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .field('type', 'TEXT')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .field('type', 'TEXT')
      .field('text', '문자와 파일 동시 전송')
      .attach('file', image, 'capture.png')
      .expect(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    {
      type: 'TEXT',
      sourceType: 'SCREEN_CROP',
      text: '파일 없는 캡처 요청입니다.',
    },
    { type: 'TEXT', sourceType: 'OTHER', text: '지원하지 않는 출처입니다.' },
    {
      type: 'TEXT',
      sourceType: null,
      text: '명시적인 null은 생략이 아닙니다.',
    },
    { type: 'TEXT', sourceType: 'DIRECT' },
    { type: 'SCREEN_CROP', text: 'AnalysisType은 추가하지 않습니다.' },
  ])('rejects invalid JSON source/input combination %j', async (body) => {
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .send(body)
      .expect(400);
    expect(db.analysis.create).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    ['TEXT', undefined],
    ['TEXT', 'DIRECT'],
    ['TEXT', 'OTHER'],
    ['IMAGE', 'SCREEN_CROP'],
    ['IMAGE', 'DIRECT'],
  ])(
    'rejects ambiguous multipart type=%s sourceType=%s',
    async (type, sourceType) => {
      const call = request(app.getHttpServer())
        .post('/api/analysis')
        .set('Authorization', `Bearer ${jwt('development-user')}`)
        .field('type', type);
      if (sourceType !== undefined) call.field('sourceType', sourceType);
      await call.attach('file', image, 'capture.png').expect(400);
      expect(db.analysis.create).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('requires a file even with an explicit multipart SCREEN_CROP', async () => {
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', `Bearer ${jwt('development-user')}`)
      .field('type', 'TEXT')
      .field('sourceType', 'SCREEN_CROP')
      .expect(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it('stores capture source before AI fails, including keyed requests', async () => {
    transport.mockResolvedValueOnce(new Response('', { status: 503 }));
    await upload('failed-source').expect(503);
    expect([...rows.values()][0]).toMatchObject({
      type: 'TEXT',
      status: 'FAILED',
      textResult: { sourceType: 'SCREEN_CROP' },
    });
  });
  it('rejects disabled OCR before persistence', async () => {
    settings.TEXT_AI_PROVIDER = 'disabled';
    await upload().expect(503);
    expect(db.analysis.create).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('persists upstream failure and clears file bytes', async () => {
    transport.mockResolvedValueOnce(new Response('', { status: 401 }));
    await upload().expect(503);
    expect([...rows.values()][0]).toMatchObject({
      status: 'FAILED',
      errorCode: 'ANALYSIS503',
      textResult: { sourceType: 'SCREEN_CROP' },
    });
    expect(
      capture.mock.calls[0][1].buffer.every((byte: number) => byte === 0),
    ).toBe(true);
  });
  it('rejects OCR context mismatch without storing results', async () => {
    transport.mockResolvedValueOnce(
      Response.json(textWire(randomUUID(), randomUUID(), 'TEXT')),
    );
    await upload().expect(503);
    expect([...rows.values()][0]).toMatchObject({
      status: 'FAILED',
      textResult: { sourceType: 'SCREEN_CROP' },
    });
  });
  it('times out OCR without storing late results', async () => {
    settings.AI_REQUEST_TIMEOUT_MS = '10';
    transport.mockImplementationOnce(() => new Promise(() => {}));
    await upload().expect(503);
    expect([...rows.values()][0]).toMatchObject({
      status: 'FAILED',
      textResult: { sourceType: 'SCREEN_CROP' },
    });
  });
});
