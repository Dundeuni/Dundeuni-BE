import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { textWire } from './fixtures/text-risk';

const dbDescribe = process.env.TEXT_AI_DB_URL ? describe : describe.skip;
dbDescribe('#17 public POST→real PostgreSQL→GET, mocked AI transport', () => {
  let prisma: PrismaClient, app: INestApplication, transport: jest.SpyInstance;
  beforeAll(async () => {
    const url = new URL(process.env.TEXT_AI_DB_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^pb23_test_\d+$/.test(url.pathname.slice(1))
    )
      throw Error('Isolated local DB required');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const settings: Record<string, string> = {
      NODE_ENV: 'development',
      TEXT_AI_PROVIDER: 'http',
      AI_SERVICE_BASE_URL: 'http://127.0.0.1:9',
      TEXT_AI_SERVICE_TOKEN: 'test-only-token',
      ANALYSIS_MAX_FILE_BYTES: '100000',
      ANALYSIS_RETENTION_SECONDS: '2592000',
      AI_REQUEST_TIMEOUT_MS: '1000',
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: (name: string) => settings[name] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue({ analyze: jest.fn() })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  beforeEach(() => {
    transport = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        if (init!.body instanceof FormData)
          return Response.json(
            textWire(
              String(init!.body.get('analysisId')),
              String(init!.body.get('elementId')),
              'SCREEN_CROP',
            ),
          );
        const input = JSON.parse(init!.body as string);
        return Response.json(textWire(input.analysisId, input.elementId));
      });
  });
  afterEach(() => transport.mockRestore());
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });
  it.each(['DIRECT', 'SCREEN_CROP'])(
    'returns normalized %s after public POST and real DB persistence',
    async (sourceType) => {
      const call = request(app.getHttpServer()).post('/api/analysis');
      const response =
        sourceType === 'DIRECT'
          ? await call
              .send({
                type: 'TEXT',
                sourceType,
                text: '합성 문자 피싱 분석 테스트입니다.',
              })
              .expect(202)
          : await call
              .field('type', 'TEXT')
              .field('sourceType', sourceType)
              .attach(
                'file',
                await sharp({
                  create: {
                    width: 4,
                    height: 4,
                    channels: 3,
                    background: 'white',
                  },
                })
                  .png()
                  .toBuffer(),
                'capture.png',
              )
              .expect(202);
      const id = response.body.result.analysisId;
      const saved = await prisma.analysis.findUniqueOrThrow({ where: { id } });
      expect(saved.status).toBe('COMPLETED');
      const result = await request(app.getHttpServer())
        .get(`/api/analysis/${id}`)
        .expect(200);
      expect(result.body.result).toMatchObject({
        type: 'TEXT',
        sourceType: sourceType === 'DIRECT' ? 'TEXT' : sourceType,
        result: {
          riskLevel: 'UNKNOWN',
          riskScore: 0.82,
          textDecision: 'phishing',
          reasons: [],
          guidance: [],
          summary: null,
        },
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['QUEUED', 'ANALYZING', 'FAILED'] as const)(
    'preserves %s capture source from real DB and hides unavailable results',
    async (status) => {
      const row = await prisma.analysis.create({
        data: {
          userId: 'development-user',
          type: 'TEXT',
          status,
          requestHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60000),
          textResult: { sourceType: 'SCREEN_CROP' },
        },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/analysis/${row.id}`)
        .expect(200);
      expect(response.body.result).toMatchObject({
        status,
        sourceType: 'SCREEN_CROP',
        result: {
          riskLevel: 'UNKNOWN',
          riskScore: null,
          textDecision: null,
          reasons: [],
          guidance: [],
          summary: null,
        },
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('excludes expired and other-user persisted records', async () => {
    for (const data of [
      { userId: 'other', expiresAt: new Date(Date.now() + 60000) },
      { userId: 'development-user', expiresAt: new Date(0) },
    ]) {
      const row = await prisma.analysis.create({
        data: { ...data, type: 'TEXT', requestHash: randomUUID() },
      });
      await request(app.getHttpServer())
        .get(`/api/analysis/${row.id}`)
        .expect(404);
    }
  });
});
