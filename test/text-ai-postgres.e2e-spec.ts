import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { textWire } from './fixtures/text-risk';

const dbDescribe = process.env.TEXT_AI_DB_URL ? describe : describe.skip;
dbDescribe(
  'TEXT backend→HTTP Mock→PostgreSQL (explicit isolated DB only)',
  () => {
    let app: INestApplication,
      prisma: PrismaClient,
      transport: jest.SpyInstance;
    const image = { analyze: jest.fn() };
    const usage = { reserveAiUsage: jest.fn(), releaseAiUsage: jest.fn() };
    const config = new ConfigService({
      TEXT_AI_PROVIDER: 'http',
      AI_SERVICE_BASE_URL: 'http://127.0.0.1:9',
      AI_SERVICE_TOKEN: 'test-only-token',
      TEXT_AI_SERVICE_TOKEN: 'test-only-token',
      ANALYSIS_MAX_FILE_BYTES: '100000',
      ANALYSIS_RETENTION_SECONDS: '86400',
      AI_REQUEST_TIMEOUT_MS: '1000',
    });
    const post = (text = 'TEXT AI 검증용 합성 입력입니다.', key?: string) => {
      const r = request(app.getHttpServer()).post('/api/analysis');
      if (key) r.set('Idempotency-Key', key);
      return r.send({ type: 'TEXT', text });
    };
    beforeAll(async () => {
      const url = new URL(process.env.TEXT_AI_DB_URL!);
      if (
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        !/^pb23_test_\d+$/.test(url.pathname.slice(1))
      )
        throw Error('Isolated test DB required');
      prisma = new PrismaClient({ datasourceUrl: url.toString() });
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ConfigService)
        .useValue(config)
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
        .useValue(image)
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
      config.set('AI_REQUEST_TIMEOUT_MS', '1000');
      jest.clearAllMocks();
      transport = jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (_url, init) => {
          const body = JSON.parse(init!.body as string);
          return Response.json(textWire(body.analysisId, body.elementId));
        });
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
      await app?.close();
      await prisma?.$disconnect();
    });
    it('persists native score/meaning/quality separately from IMAGE, without raw text or free-form fields', async () => {
      const response = await post(
        'a'.repeat(200) + 'never-persist-tail',
      ).expect(202);
      const row = await prisma.analysis.findUniqueOrThrow({
        where: { id: response.body.result.analysisId },
        include: { modelResults: true },
      });
      expect(row.status).toBe('COMPLETED');
      expect(row.type).toBe('TEXT');
      expect(row.textResult).toMatchObject({
        riskScore: 0.82,
        scoreScale: '0..1',
        scoreMeaning: 'UNCALIBRATED_CLASSIFIER_SCORE',
        decision: 'phishing',
      });
      expect(row.aiGenerationScore).toBeNull();
      expect(row.aiRiskLevel).toBeNull();
      expect(row.modelResults).toHaveLength(0);
      expect(row.reasons).toBeNull();
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
        30 * 86400000,
      );
      expect(JSON.stringify(row)).not.toMatch(
        /never-persist-tail|private original/,
      );
      expect(JSON.stringify(response.body)).not.toMatch(/private original/);
      expect(row.textResult).not.toHaveProperty('text');
      expect(row.textResult).not.toHaveProperty('evidence');
      expect(row.textResult).not.toHaveProperty('phishingScore');
      expect(row.textResult).not.toHaveProperty('riskLevel');
      expect(usage.reserveAiUsage).not.toHaveBeenCalled();
      expect(image.analyze).not.toHaveBeenCalled();
    });
    it('preserves null/defer instead of normal/zero', async () => {
      transport.mockImplementationOnce(async (_url, init) => {
        const ctx = JSON.parse(init!.body as string);
        return Response.json({
          ...textWire(ctx.analysisId, ctx.elementId),
          decision: 'defer',
          riskScore: null,
        });
      });
      const response = await post().expect(202);
      expect(response.body.result.textResult).toMatchObject({
        decision: 'defer',
        riskScore: null,
      });
    });
    it('reuses completed responses without another AI call, rejects conflicting content and expired keys', async () => {
      const key = 'text-' + randomUUID();
      const first = await post(undefined, key).expect(202);
      const second = await post(undefined, key).expect(202);
      expect(second.body).toEqual(first.body);
      expect(transport).toHaveBeenCalledTimes(1);
      await post('different TEXT content', key).expect(409);
      await prisma.analysis.update({
        where: { id: first.body.result.analysisId },
        data: { expiresAt: new Date(0) },
      });
      await post(undefined, key).expect(409);
      expect(transport).toHaveBeenCalledTimes(1);
    });
    it('allows distinct keys with identical text', async () => {
      const a = await post(undefined, randomUUID()).expect(202),
        b = await post(undefined, randomUUID()).expect(202);
      expect(a.body.result.analysisId).not.toBe(b.body.result.analysisId);
      expect(transport).toHaveBeenCalledTimes(2);
    });
    it('atomically claims concurrent same-key requests before calling AI', async () => {
      transport.mockImplementation(async (_url, init) => {
        const ctx = JSON.parse(init!.body as string);
        await new Promise((r) => setTimeout(r, 100));
        return Response.json(textWire(ctx.analysisId, ctx.elementId));
      });
      const key = 'concurrent-' + randomUUID();
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => post(undefined, key)),
      );
      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(7);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(
        await prisma.analysis.count({
          where: { userId: 'development-user', idempotencyKey: key },
        }),
      ).toBe(1);
    });
    it.each([401, 403, 422, 500, 503])(
      'persists HTTP %i failure and does not automatically retry',
      async (status) => {
        transport.mockResolvedValueOnce(
          new Response('private upstream trace', { status }),
        );
        const key = 'failed-' + randomUUID();
        await post(undefined, key).expect(503);
        await post(undefined, key).expect(503);
        const row = await prisma.analysis.findUniqueOrThrow({
          where: {
            userId_idempotencyKey: {
              userId: 'development-user',
              idempotencyKey: key,
            },
          },
        });
        expect(row.status).toBe('FAILED');
        expect(row.textResult).toBeNull();
        expect(row.errorCode).toBe('ANALYSIS503');
        expect(transport).toHaveBeenCalledTimes(1);
      },
    );
    it('rejects malformed AI contract before writing results', async () => {
      transport.mockResolvedValueOnce(Response.json({ riskScore: 82 }));
      const key = randomUUID();
      await post(undefined, key).expect(503);
      const row = await prisma.analysis.findUniqueOrThrow({
        where: {
          userId_idempotencyKey: {
            userId: 'development-user',
            idempotencyKey: key,
          },
        },
      });
      expect(row.status).toBe('FAILED');
      expect(row.textResult).toBeNull();
    });
    it('preserves initial provider failure even when FAILED persistence fails', async () => {
      transport.mockRejectedValueOnce(new TypeError('private network'));
      jest
        .spyOn(app.get(AnalysisRepository), 'fail')
        .mockRejectedValueOnce(new Error('private DB'));
      const response = await post().expect(503);
      expect(response.body.code).toBe('ANALYSIS503');
      expect(JSON.stringify(response.body)).not.toContain('private');
    });
    it('marks FAILED when result storage fails', async () => {
      const key = randomUUID();
      jest
        .spyOn(app.get(AnalysisRepository), 'completeText')
        .mockRejectedValueOnce(new Error('private DB'));
      await post(undefined, key).expect(500);
      const row = await prisma.analysis.findUniqueOrThrow({
        where: {
          userId_idempotencyKey: {
            userId: 'development-user',
            idempotencyKey: key,
          },
        },
      });
      expect(row.status).toBe('FAILED');
      expect(row.textResult).toBeNull();
    });
    it('times out, aborts the request and ignores a late response', async () => {
      config.set('AI_REQUEST_TIMEOUT_MS', '10');
      let finish!: (value: Response) => void;
      let context: any;
      let signal: AbortSignal;
      transport.mockImplementationOnce(async (_url, init) => {
        context = JSON.parse(init!.body as string);
        signal = init!.signal as AbortSignal;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      });
      const key = randomUUID();
      await post(undefined, key).expect(503);
      expect(signal!.aborted).toBe(true);
      finish(Response.json(textWire(context.analysisId, context.elementId)));
      await new Promise<void>((r) => setImmediate(r));
      const row = await prisma.analysis.findUniqueOrThrow({
        where: { id: context.analysisId },
      });
      expect(row.status).toBe('FAILED');
      expect(row.textResult).toBeNull();
    });
    it('keeps #13 input limits before AI and storage', async () => {
      const count = await prisma.analysis.count();
      await post('abcd').expect(400);
      await post('a'.repeat(3001)).expect(400);
      expect(await prisma.analysis.count()).toBe(count);
      expect(transport).not.toHaveBeenCalled();
    });
  },
);
