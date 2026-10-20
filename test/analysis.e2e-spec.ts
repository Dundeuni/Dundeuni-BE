import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Analysis } from '@prisma/client';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { MockImageAnalysisProvider } from '../src/domains/analysis/mock-image-analysis.provider';
import { ImageModelsPublicResultDto } from '../src/domains/analysis/image-analysis-v1.dto';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';

const secret = 'test-access-secret';
const png = () =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',
    'base64',
  );

describe('IMAGE analysis API', () => {
  let app: INestApplication;
  let rows: Map<string, Analysis>;
  let modelRows: Map<string, ImageModelsPublicResultDto>;
  const provider = { analyze: jest.fn() };
  const usage = { reserveAiUsage: jest.fn(), releaseAiUsage: jest.fn() };
  const repository = {
    create: jest.fn(
      async (userId: string, requestHash: string, expiresAt: Date) => {
        const row: Analysis = {
          id: randomUUID(),
          userId,
          requestHash,
          idempotencyKey: null,
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
    claim: jest.fn(
      async (
        userId: string,
        requestHash: string,
        expiresAt: Date,
        idempotencyKey: string,
      ): Promise<{ analysis: Analysis; claimed: boolean }> => {
        const existing = [...rows.values()].find(
          (row) =>
            row.userId === userId && row.idempotencyKey === idempotencyKey,
        );
        if (existing) return { analysis: existing, claimed: false };
        const pending = repository.create(userId, requestHash, expiresAt);
        // In-memory unique insert emulates the DB claim before yielding.
        const row = [...rows.values()].at(-1)!;
        row.idempotencyKey = idempotencyKey;
        return { analysis: await pending, claimed: true };
      },
    ),
    analyzing: jest.fn(async (id: string) =>
      update(id, { status: 'ANALYZING' }),
    ),
    complete: jest.fn(async (id: string, result: object) =>
      update(id, { ...result, status: 'COMPLETED', completedAt: new Date() }),
    ),
    completeV1: jest.fn(
      async (
        id: string,
        result: ImageModelsPublicResultDto,
        completedAt: Date,
      ) => {
        modelRows.set(id, result);
        const generation =
          result.generation?.status === 'SUCCEEDED' ? result.generation : null;
        return update(id, {
          status: result.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
          imageResultStatus: result.status,
          completedAt,
          errorCode: result.status === 'FAILED' ? 'ANALYSIS503' : null,
          aiGenerationScore: generation?.displayScore ?? null,
          aiRiskLevel: null,
          reasons: generation?.reasons ?? null,
          modelVersion: generation?.modelVersion ?? null,
        });
      },
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
            AI_REQUEST_TIMEOUT_MS: '100',
            ANALYSIS_MAX_FILE_BYTES: '128',
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
    modelRows = new Map();
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
      .attach('file', Buffer.alloc(129), 'sample.png')
      .expect(413);
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
  it('rejects reuse of a key for different images', async () => {
    await post()
      .set('Idempotency-Key', '1')
      .field('type', 'IMAGE')
      .attach('file', png(), 'sample.png')
      .expect(202);
    await post()
      .set('Idempotency-Key', '1')
      .field('type', 'IMAGE')
      .attach('file', Buffer.concat([png(), Buffer.from([2])]), 'sample.png')
      .expect(409);
    expect(rows.size).toBe(1);
  });
  const keyedUpload = (key: string) =>
    post()
      .set('Idempotency-Key', key)
      .field('type', 'IMAGE')
      .attach('file', png(), 'sample.png');
  it('reuses a completed response without duplicate AI or usage', async () => {
    const first = await keyedUpload('repeat').expect(202);
    const second = await keyedUpload('repeat').expect(202);
    expect(second.body).toEqual(first.body);
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(usage.reserveAiUsage).toHaveBeenCalledTimes(1);
  });
  it('allows identical images under different keys', async () => {
    await keyedUpload('one').expect(202);
    await keyedUpload('two').expect(202);
    expect(provider.analyze).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
  });
  it('returns 409 for concurrent in-progress duplicate without executing twice', async () => {
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    provider.analyze.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = keyedUpload('concurrent').then((response) => response);
    await started;
    await keyedUpload('concurrent').expect(409);
    finish({
      aiGenerationScore: 50,
      aiRiskLevel: 'CAUTION',
      reasons: [],
      modelVersion: 'test',
    });
    expect((await first).status).toBe(202);
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(usage.reserveAiUsage).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });
  it('replays failed requests without retrying AI or usage', async () => {
    provider.analyze.mockRejectedValueOnce(new Error('failure'));
    await keyedUpload('failed').expect(503);
    await keyedUpload('failed').expect(503);
    expect(provider.analyze).toHaveBeenCalledTimes(1);
    expect(usage.reserveAiUsage).toHaveBeenCalledTimes(1);
    expect(usage.releaseAiUsage).toHaveBeenCalledTimes(1);
  });
  it('rejects expired keys and invalid keys', async () => {
    await keyedUpload('expired').expect(202);
    [...rows.values()][0].expiresAt = new Date(0);
    await keyedUpload('expired').expect(409);
    await keyedUpload('contains space').expect(400);
    expect(provider.analyze).toHaveBeenCalledTimes(1);
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
    await upload().expect(503);
    expect(usage.releaseAiUsage).toHaveBeenCalledTimes(1);
  });
  it('preserves the original error when usage release fails', async () => {
    provider.analyze.mockRejectedValueOnce(new Error('private upstream trace'));
    usage.releaseAiUsage.mockRejectedValueOnce(
      new Error('private usage trace'),
    );
    const response = await upload().expect(503);
    expect(response.body.code).toBe('ANALYSIS503');
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect([...rows.values()][0].status).toBe('FAILED');
  });
  it('ignores a provider response arriving after timeout', async () => {
    let resolve!: (value: unknown) => void;
    provider.analyze.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await upload().expect(503);
    resolve({
      aiGenerationScore: 50,
      aiRiskLevel: 'CAUTION',
      reasons: [],
      modelVersion: 'late',
    });
    await new Promise<void>((done) => setImmediate(done));
    expect([...rows.values()][0].status).toBe('FAILED');
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.completeV1).not.toHaveBeenCalled();
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
  it.each([
    ['BOTH_SUCCESS', 202, 'COMPLETED', 80],
    ['GENERATION_SUSPECTED', 202, 'COMPLETED', 80],
    ['MANIPULATION_SUSPECTED', 202, 'COMPLETED', 0],
    ['NO_CLEAR_SIGNAL', 202, 'COMPLETED', 0],
    ['BOTH_INCONCLUSIVE', 202, 'COMPLETED', null],
    ['GENERATION_FAILED', 202, 'PARTIAL_FAILED', null],
    ['MANIPULATION_FAILED', 202, 'PARTIAL_FAILED', 80],
    ['BOTH_FAILED', 503, 'FAILED', null],
    ['INCONCLUSIVE', 202, 'COMPLETED', null],
  ] as const)(
    'connects Mock %s without changing FE fields',
    async (scenario, http, aggregate, score) => {
      const mock = new MockImageAnalysisProvider(scenario);
      provider.analyze.mockImplementationOnce((...args) =>
        mock.analyze(args[0], args[1], args[2]),
      );
      const response = await upload().expect(http);
      const row = [...rows.values()][0];
      expect(row.imageResultStatus).toBe(aggregate);
      expect(row.status).toBe(http === 503 ? 'FAILED' : 'COMPLETED');
      expect(modelRows.get(row.id)?.generation).not.toBeNull();
      expect(modelRows.get(row.id)?.manipulation).not.toBeNull();
      const request = provider.analyze.mock.calls[0][1];
      expect(request).toMatchObject({
        analysisId: row.id,
        sourceType: 'IMAGE',
        models: 'ALL',
      });
      expect(request.elementId).toMatch(/^[0-9a-f-]{36}$/);
      if (http === 202) {
        expect(response.body.result.aiGenerationScore).toBe(score);
        expect(response.body.result.aiRiskLevel).toBeNull();
        expect(response.body.result).not.toHaveProperty('generation');
        expect(response.body.result).not.toHaveProperty('rawScore');
        expect(Object.keys(response.body.result).sort()).toEqual(
          [
            'analysisId',
            'type',
            'status',
            'aiGenerationScore',
            'aiRiskLevel',
            'reasons',
            'modelVersion',
            'errorCode',
            'createdAt',
            'completedAt',
            'expiresAt',
          ].sort(),
        );
      } else {
        expect(response.body).toMatchObject({
          isSuccess: false,
          code: 'ANALYSIS503',
          result: null,
        });
        expect(repository.fail).not.toHaveBeenCalled();
        expect(usage.releaseAiUsage).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('times out Mock, marks FAILED, aborts and cleans the image', async () => {
    const mock = new MockImageAnalysisProvider('TIMEOUT');
    provider.analyze.mockImplementationOnce((...args) =>
      mock.analyze(args[0], args[1], args[2]),
    );
    await upload().expect(503);
    expect([...rows.values()][0].status).toBe('FAILED');
    expect(provider.analyze.mock.calls[0][2].aborted).toBe(true);
    expect(
      provider.analyze.mock.calls[0][0].buffer.every(
        (byte: number) => byte === 0,
      ),
    ).toBe(true);
    expect(repository.completeV1).not.toHaveBeenCalled();
  });
  it('rejects malformed v1 data and mismatched context before persistence', async () => {
    provider.analyze.mockImplementationOnce(async (...args) => ({
      ...(await new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
        args[0],
        args[1],
      )),
      analysisId: 'other',
    }));
    await upload().expect(503);
    expect(repository.completeV1).not.toHaveBeenCalled();
  });
  it('returns COMMON500 on v1 storage failure', async () => {
    provider.analyze.mockImplementationOnce((...args) =>
      new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
        args[0],
        args[1],
        args[2],
      ),
    );
    repository.completeV1.mockRejectedValueOnce(new Error('DB error'));
    const response = await upload().expect(500);
    expect(response.body.code).toBe('COMMON500');
    expect([...rows.values()][0].status).toBe('FAILED');
  });
  it('accepts a JPEG upload with Mock', async () => {
    provider.analyze.mockImplementationOnce((...args) =>
      new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
        args[0],
        args[1],
        args[2],
      ),
    );
    await post()
      .field('type', 'IMAGE')
      .attach('file', Buffer.from([255, 216, 255, 217]), 'test.jpg')
      .expect(202);
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
    expect(operation.parameters ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key' }),
      ]),
    );
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['202', '400', '413', '429', '415', '503', '500']),
    );
  });
});
