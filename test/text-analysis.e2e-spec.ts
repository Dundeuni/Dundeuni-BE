import { configureAnalysisSwagger } from '../src/domains/analysis/analysis.swagger';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Analysis } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { TEXT_RETENTION_MS } from '../src/domains/analysis/text-analysis.input';

describe('TEXT analysis JSON API with real Service/Repository and mocked Prisma transport', () => {
  let app: INestApplication;
  let rows: Analysis[];
  const ai = { analyze: jest.fn() };
  const usage = { reserveAiUsage: jest.fn(), releaseAiUsage: jest.fn() };
  const db = { analysis: { create: jest.fn(), findFirst: jest.fn() } };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          NODE_ENV: 'development',
          ANALYSIS_MAX_FILE_BYTES: '100000',
          ANALYSIS_RETENTION_SECONDS: '86400',
          AI_REQUEST_TIMEOUT_MS: '100',
        }),
      )
      .overrideProvider(PrismaService)
      .useValue(db)
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue(ai)
      .overrideProvider(AnalysisUsageService)
      .useValue(usage)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
  });
  beforeEach(() => {
    rows = [];
    jest.clearAllMocks();
    db.analysis.create.mockReset().mockImplementation(async ({ data }) => {
      const row = {
        id: randomUUID(),
        aiGenerationScore: null,
        aiRiskLevel: null,
        reasons: null,
        modelVersion: null,
        completedAt: null,
        errorCode: null,
        imageResultStatus: null,
        ...data,
      } as Analysis;
      rows.push(row);
      return row;
    });
  });
  afterAll(async () => {
    await app?.close();
  });
  const post = (text: unknown) =>
    request(app.getHttpServer())
      .post('/api/analysis')
      .send({ type: 'TEXT', text });

  it.each([5, 3000])(
    'accepts %i characters and persists QUEUED without AI/Usage',
    async (length) => {
      const before = Date.now();
      const response = await post('가'.repeat(length)).expect(202);
      expect(response.body.code).toBe('ANALYSIS202');
      expect(response.body.result).toMatchObject({
        type: 'TEXT',
        status: 'QUEUED',
        textPreview: '가'.repeat(Math.min(length, 200)),
      });
      expect(response.body.result.analysisId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const row = rows[0];
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.updatedAt).toEqual(row.createdAt);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
        TEXT_RETENTION_MS,
      );
      expect(response.body.result.expiresAt).toBe(row.expiresAt.toISOString());
      expect(ai.analyze).not.toHaveBeenCalled();
      expect(usage.reserveAiUsage).not.toHaveBeenCalled();
      expect(response.body.result).not.toHaveProperty('aiRiskLevel');
      expect(db.analysis.create).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ['four characters', '가나다라'],
    ['3001 characters', '가'.repeat(3001)],
    ['empty', ''],
    ['spaces', ' \t\n '],
    ['trimmed short', '  abcd  '],
    ['number', 12345],
    ['null', null],
    ['missing', undefined],
    ['array', ['abcde']],
    ['object', { text: 'abcde' }],
    ['boolean', true],
  ])('rejects %s before persistence', async (_label, text) => {
    const response = await post(text).expect(400);
    expect(response.body.code).toBe('COMMON400');
    expect(db.analysis.create).not.toHaveBeenCalled();
    expect(ai.analyze).not.toHaveBeenCalled();
  });
  it('trims input before hashing and preview, excluding undeclared original fields', async () => {
    const first = await post(' \n abcde \t ').expect(202);
    await post('abcde').expect(202);
    expect(first.body.result.textPreview).toBe('abcde');
    expect(rows[0].requestHash).toBe(rows[1].requestHash);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(
      Object.keys(db.analysis.create.mock.calls[0][0].data).sort(),
    ).toEqual(
      [
        'userId',
        'requestHash',
        'textPreview',
        'type',
        'status',
        'createdAt',
        'updatedAt',
        'expiresAt',
      ].sort(),
    );
  });
  it('keeps Unicode characters intact when truncating preview and counts code points', async () => {
    await post('😀'.repeat(5)).expect(202);
    const response = await post('😀'.repeat(201)).expect(202);
    expect(Array.from(response.body.result.textPreview)).toHaveLength(200);
    expect(response.body.result.textPreview).toBe('😀'.repeat(200));
    await post('😀'.repeat(4)).expect(400);
  });
  it('uses the same code point policy for variation selectors and direct service callers', async () => {
    const text = '✈️✈️a'; // five code points, three displayed glyphs
    const response = await post(text).expect(202);
    expect(response.body.result.textPreview).toBe(text);
    await expect(
      app.get(AnalysisService).createText('test-user', text),
    ).resolves.toMatchObject({ result: { status: 'QUEUED' } });
  });
  it('does not store or return the portion of the original beyond preview', async () => {
    const text = 'a'.repeat(200) + 'private-tail';
    const response = await post(text).expect(202);
    expect(JSON.stringify(db.analysis.create.mock.calls)).not.toContain(
      'private-tail',
    );
    expect(JSON.stringify(response.body)).not.toContain('private-tail');
    expect(response.body.result).not.toHaveProperty('text');
  });
  it('rejects multipart TEXT and TEXT idempotency keys before persistence', async () => {
    await request(app.getHttpServer())
      .post('/api/analysis')
      .field('type', 'TEXT')
      .field('text', 'abcde')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Idempotency-Key', 'text-key')
      .send({ type: 'TEXT', text: 'abcde' })
      .expect(400);
    expect(db.analysis.create).not.toHaveBeenCalled();
  });
  it('sanitizes persistence failures', async () => {
    db.analysis.create.mockRejectedValueOnce(
      new Error('private database secret'),
    );
    const response = await post('abcde').expect(500);
    expect(response.body.code).toBe('COMMON500');
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(ai.analyze).not.toHaveBeenCalled();
  });
  it('validates direct service callers before storage as well', async () => {
    await expect(
      app.get(AnalysisService).createText('test-user', 'abcd'),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.analysis.create).not.toHaveBeenCalled();
  });
  it('requires user ownership, TEXT type and unexpired time in the history query', async () => {
    const now = new Date('2026-10-20T00:00:00.000Z');
    const id = randomUUID();
    await app
      .get(AnalysisRepository)
      .findActiveTextForUser(id, 'test-user', now);
    expect(db.analysis.findFirst).toHaveBeenCalledWith({
      where: { id, userId: 'test-user', type: 'TEXT', expiresAt: { gt: now } },
      select: {
        id: true,
        type: true,
        status: true,
        textPreview: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
      },
    });
  });
  it('documents both input formats and TEXT constraints', () => {
    const doc = configureAnalysisSwagger(
      SwaggerModule.createDocument(app, new DocumentBuilder().build()),
    );
    const body = doc.paths['/api/analysis'].post!.requestBody as any;
    expect(Object.keys(body.content).sort()).toEqual([
      'application/json',
      'multipart/form-data',
    ]);
    expect(body.content['application/json'].schema).toMatchObject({
      required: ['type', 'text'],
      properties: { text: { minLength: 5, maxLength: 3000 } },
    });
  });
});
