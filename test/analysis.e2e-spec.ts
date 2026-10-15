import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Analysis } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';

const secret = 'test-access-secret';
const png = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC',
    'base64',
  );

describe('IMAGE analysis API', () => {
  let app: INestApplication;
  let rows: Map<string, Analysis>;
  const provider = { analyze: jest.fn() };
  const usage = { reserveAiUsage: jest.fn(), releaseAiUsage: jest.fn() };
  const repository = {
    create: jest.fn(
      async (userId: string, requestHash: string, expiresAt: Date) => {
        const row: Analysis = {
          id: `id-${rows.size}`,
          userId,
          requestHash,
          expiresAt,
          type: 'IMAGE',
          status: 'QUEUED',
          aiGenerationScore: null,
          aiRiskLevel: null,
          reasons: null,
          modelVersion: null,
          imageResultStatus: null,
          summary: null,
          summaryStatus: null,
          summaryModel: null,
          summarizedAt: null,
          errorCode: null,
          createdAt: new Date(),
          completedAt: null,
        };
        rows.set(row.id, row);
        return row;
      },
    ),
    analyzing: jest.fn(async (id: string) =>
      update(id, { status: 'ANALYZING' }),
    ),
    complete: jest.fn(async (id: string, result: object) =>
      update(id, { ...result, status: 'COMPLETED', completedAt: new Date() }),
    ),
    fail: jest.fn(async (id: string, errorCode: string) =>
      update(id, { status: 'FAILED', errorCode, completedAt: new Date() }),
    ),
  };
  function update(id: string, patch: object) {
    const row = [...rows.values()].find((value) => value.id === id)!;
    Object.assign(row, patch);
    return row;
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string) =>
          ({
            JWT_ACCESS_SECRET: secret,
            ANALYSIS_MAX_FILE_BYTES: '1024',
            ANALYSIS_RETENTION_SECONDS: '86400',
          })[key],
      })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(AnalysisRepository)
      .useValue(repository)
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue(provider)
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
    rows = new Map();
    jest.clearAllMocks();
    provider.analyze.mockReset().mockResolvedValue({
      aiGenerationScore: 82.4,
      aiRiskLevel: 'CAUTION',
      reasons: [{ description: '테스트 Provider 근거' }],
      modelVersion: 'test-only',
    });
    usage.reserveAiUsage.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await app.close();
  });
  const post = () => request(app.getHttpServer()).post('/api/analysis');
  const upload = () =>
    post().field('type', 'IMAGE').attach('file', png(), 'sample.png');

  it('accepts IMAGE and returns separate AI result', async () => {
    const response = await upload().expect(202);
    expect(response.body.result).toMatchObject({
      type: 'IMAGE',
      status: 'COMPLETED',
      aiGenerationScore: 82.4,
      errorCode: null,
    });
    expect(response.body.result.fraudScore).toBeUndefined();
    expect(usage.reserveAiUsage).toHaveBeenCalledTimes(1);
    expect(
      provider.analyze.mock.calls[0][0].buffer.every(
        (byte: number) => byte === 0,
      ),
    ).toBe(true);
  });
  it.each(['TEXT', 'URL', 'SCREEN', 'VIDEO', 'invalid'])(
    'rejects %s',
    async (type) => {
      const response = await post()
        .field('type', type)
        .attach('file', png(), 'sample.png')
        .expect(400);
      expect(response.body.code).toBe('COMMON400');
      expect(response.body.message).toContain('현재 IMAGE 분석만 지원');
      expect(repository.create).not.toHaveBeenCalled();
    },
  );
  it('rejects missing type', async () => {
    await post().attach('file', png(), 'sample.png').expect(400);
  });
  it('rejects missing file', async () => {
    await post().field('type', 'IMAGE').expect(400);
  });
  it('rejects wrong MIME', async () => {
    await post()
      .field('type', 'IMAGE')
      .attach('file', png(), {
        filename: 'sample.png',
        contentType: 'text/plain',
      })
      .expect(415);
  });
  it('rejects mismatched signature', async () => {
    await post()
      .field('type', 'IMAGE')
      .attach('file', Buffer.from('fake'), 'sample.png')
      .expect(415);
  });
  it('rejects mismatched extension', async () => {
    await post()
      .field('type', 'IMAGE')
      .attach('file', png(), {
        filename: 'sample.jpg',
        contentType: 'image/png',
      })
      .expect(415);
  });
  it('rejects oversized uploads', async () => {
    await post()
      .field('type', 'IMAGE')
      .attach('file', Buffer.alloc(1025), 'sample.png')
      .expect(413);
  });
  it('accepts a decoded JPEG', async () => {
    const jpeg = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'white' },
    })
      .jpeg()
      .toBuffer();
    const response = await post()
      .field('type', 'IMAGE')
      .attach('file', jpeg, 'sample.jpeg')
      .expect(202);
    expect(response.body).toMatchObject({
      isSuccess: true,
      code: 'ANALYSIS202',
    });
  });
  it.each([
    ['empty', Buffer.alloc(0), 400],
    ['PNG signature only', png().subarray(0, 8), 400],
    ['truncated PNG', png().subarray(0, 45), 400],
    ['JPEG signature only', Buffer.from([255, 216, 255, 224]), 400],
    ['unsupported format', Buffer.from('GIF89a'), 415],
  ])('rejects %s before any side effects', async (name, bytes, status) => {
    const filename = String(name).includes('JPEG')
      ? 'sample.jpg'
      : 'sample.png';
    const response = await post()
      .field('type', 'IMAGE')
      .attach('file', bytes as Buffer, filename)
      .expect(status as number);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: `COMMON${status}`,
      result: null,
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(usage.reserveAiUsage).not.toHaveBeenCalled();
    expect(provider.analyze).not.toHaveBeenCalled();
  });
  it('rejects duplicate type fields', async () => {
    await post()
      .field('type', 'IMAGE')
      .field('type', 'IMAGE')
      .attach('file', png(), 'sample.png')
      .expect(400);
  });
  it('rejects an unexpected file field', async () => {
    await post()
      .field('type', 'IMAGE')
      .attach('image', png(), 'sample.png')
      .expect(400);
  });
  it('rejects TEXT with text while unimplemented', async () => {
    await post().field('type', 'TEXT').field('text', 'example').expect(400);
    expect(provider.analyze).not.toHaveBeenCalled();
  });
  it('uses the temporary user without an access token', async () => {
    await upload().expect(202);
    expect([...rows.values()][0].userId).toBe('development-user');
  });
  it('temporarily ignores invalid access tokens', async () => {
    await post()
      .set('Authorization', 'Bearer invalid')
      .field('type', 'IMAGE')
      .attach('file', png(), 'sample.png')
      .expect(202);
    expect([...rows.values()][0].userId).toBe('development-user');
  });
  it('creates a fresh analysis for each request without a key', async () => {
    const first = await upload().expect(202);
    const second = await upload().expect(202);
    expect(second.body.result.analysisId).not.toBe(
      first.body.result.analysisId,
    );
    expect(provider.analyze).toHaveBeenCalledTimes(2);
    expect(usage.reserveAiUsage).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
  });
  it('creates separate analyses for concurrent identical requests', async () => {
    await Promise.all([upload().expect(202), upload().expect(202)]);
    expect(rows.size).toBe(2);
    expect(usage.reserveAiUsage).toHaveBeenCalledTimes(2);
  });
  it('ignores an old key header when submitting different images', async () => {
    await post()
      .set('Idempotency-Key', '1')
      .field('type', 'IMAGE')
      .attach('file', png(), 'sample.png')
      .expect(202);
    await post()
      .set('Idempotency-Key', '1')
      .field('type', 'IMAGE')
      .attach('file', Buffer.concat([png(), Buffer.from([2])]), 'sample.png')
      .expect(202);
    expect(rows.size).toBe(2);
  });
  it('persists Provider failure and allows a fresh retry', async () => {
    provider.analyze.mockRejectedValueOnce(new Error('Provider unavailable'));
    const result = await upload().expect(503);
    expect(result.body.code).toBe('ANALYSIS503');
    await upload().expect(202);
    expect(provider.analyze).toHaveBeenCalledTimes(2);
    expect([...rows.values()].map((row) => row.status)).toEqual([
      'FAILED',
      'COMPLETED',
    ]);
    expect(usage.releaseAiUsage).toHaveBeenCalledTimes(1);
  });
  it('handles DB creation failure', async () => {
    repository.create.mockRejectedValueOnce(new Error('Database error'));
    const result = await upload().expect(500);
    expect(result.body.code).toBe('COMMON500');
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(usage.reserveAiUsage).not.toHaveBeenCalled();
  });
  it('handles result persistence failure', async () => {
    repository.complete.mockRejectedValueOnce(new Error('Database error'));
    await upload().expect(500);
    expect([...rows.values()][0].status).toBe('FAILED');
  });
  it('releases a reservation even when failure persistence also fails', async () => {
    provider.analyze.mockRejectedValueOnce(new Error('Provider unavailable'));
    repository.fail.mockRejectedValueOnce(new Error('Database unavailable'));
    await upload().expect(500);
    expect(usage.releaseAiUsage).toHaveBeenCalledTimes(1);
  });
  it('handles Usage quota exceeded', async () => {
    const { ApiError } = await import('../src/common/http/api-error');
    usage.reserveAiUsage.mockRejectedValueOnce(
      new ApiError(429, 'USAGE429', '이용량 초과'),
    );
    await upload().expect(429);
    expect(provider.analyze).not.toHaveBeenCalled();
    expect(usage.releaseAiUsage).not.toHaveBeenCalled();
  });
  it('uses unavailable production Provider without fake results', async () => {
    const { UnavailableImageAnalysisProvider } =
      await import('../src/domains/analysis/image-analysis.service');
    await expect(
      new UnavailableImageAnalysisProvider().analyze(),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('rejects invalid Provider scores', async () => {
    provider.analyze.mockResolvedValueOnce({ aiGenerationScore: 101 });
    await upload().expect(503);
  });
  it('persists only declared Provider result fields', async () => {
    provider.analyze.mockResolvedValueOnce({
      aiGenerationScore: 42,
      aiRiskLevel: 'CAUTION',
      modelVersion: 'test-only',
      reasons: [{ description: '테스트 근거', undeclaredData: 'discard-me' }],
      fraudScore: 99,
    });
    const response = await upload().expect(202);
    expect(response.body.result.reasons).toEqual([
      { description: '테스트 근거' },
    ]);
    expect([...rows.values()][0].reasons).toEqual([
      { description: '테스트 근거' },
    ]);
    expect(response.body.result.fraudScore).toBeUndefined();
  });
  it('keeps health API working', async () => {
    await request(app.getHttpServer())
      .get('/api/health')
      .expect(200, { status: 'ok' });
  });
  it('documents unauthenticated multipart requests and all responses', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    const operation = doc.paths['/api/analysis'].post!;
    expect(operation.security ?? []).toEqual([]);
    expect(operation.requestBody).toMatchObject({
      content: {
        'multipart/form-data': { schema: { required: ['type', 'file'] } },
      },
    });
    expect(operation.parameters ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key' }),
      ]),
    );
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['202', '400', '413', '429', '415', '503', '500']),
    );
  });
});
