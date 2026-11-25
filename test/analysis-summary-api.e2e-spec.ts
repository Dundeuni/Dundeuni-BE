import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { AnalysisController } from '../src/domains/analysis/analysis.controller';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { AnalysisSummaryRepository } from '../src/domains/analysis/analysis-summary.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { summaryOptions } from '../src/domains/analysis/image-summary-content';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { UploadedImageCleanupInterceptor } from '../src/domains/analysis/uploaded-image-cleanup.interceptor';

describe('summary HTTP API', () => {
  let app: INestApplication;
  const id = randomUUID();
  const prisma = { analysis: { findFirst: jest.fn() } };
  const secret = 'summary-e2e-jwt-secret';
  const config = new ConfigService({
    NODE_ENV: 'development',
    JWT_ACCESS_SECRET: secret,
  });
  function token(sub: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');
    const body = `${header}.${payload}`;
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AnalysisController],
      providers: [
        AnalysisSummaryRepository,
        UploadedImageCleanupInterceptor,
        { provide: AnalysisService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: config,
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it.each(['PENDING', 'COMPLETED', 'FAILED', null])(
    'returns %s using the common envelope',
    async (status) => {
      prisma.analysis.findFirst.mockResolvedValue({
        id,
        summaryStatus: status,
        summary: 'stored',
        summaryModel: 'mock',
        summarizedAt: new Date('2026-10-13T00:00:00Z'),
      });
      const response = await request(app.getHttpServer())
        .get(`/api/analysis/${id}/summary`)
        .expect(200);
      expect(response.body).toMatchObject({
        isSuccess: true,
        code: 'ANALYSIS200',
        result: {
          analysisId: id,
          summaryStatus: status,
          summary: status === 'COMPLETED' ? 'stored' : null,
          detailedReasons: [],
          actionGuides: [],
          reassurance: null,
        },
      });
      expect(prisma.analysis.findFirst).toHaveBeenLastCalledWith({
        where: {
          id,
          userId: 'development-user',
          expiresAt: { gt: expect.any(Date) },
        },
      });
    },
  );
  it('returns only safe structured content for completed records', async () => {
    const choices = summaryOptions({
      generation: null,
      manipulation: null,
      overallResult: { decision: 'INCONCLUSIVE' },
    });
    const detail = {
      detailedReasons: [],
      actionGuides: choices.actionGuides.slice(0, 3),
      reassurance: choices.reassurances[0],
    };
    prisma.analysis.findFirst.mockResolvedValue({
      id,
      summaryStatus: 'COMPLETED',
      summary: choices.summaries[0],
      summaryDetail: detail,
    });
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}/summary`)
      .expect(200);
    expect(response.body.result).toMatchObject(detail);
    expect(response.body.result).not.toHaveProperty('overallDecision');
    expect(response.body.result).not.toHaveProperty('summaryDetail');
  });

  it('discards unsafe stored detail without dropping the legacy summary', async () => {
    prisma.analysis.findFirst.mockResolvedValue({
      id,
      summaryStatus: 'COMPLETED',
      summary: 'stored',
      summaryDetail: {
        detailedReasons: [],
        actionGuides: [],
        reassurance: 'private@example.test',
      },
    });
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}/summary`)
      .expect(200);
    expect(response.body.result).toMatchObject({
      summary: 'stored',
      detailedReasons: [],
      actionGuides: [],
      reassurance: null,
    });
    expect(response.text).not.toContain('private@example.test');
  });

  it('describes structured arrays using nested Swagger DTOs', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(
      document.components?.schemas?.AnalysisSummaryResultDto,
    ).toMatchObject({
      properties: {
        detailedReasons: {
          type: 'array',
          items: { $ref: '#/components/schemas/DetailedReasonDto' },
        },
        actionGuides: {
          type: 'array',
          items: { $ref: '#/components/schemas/ActionGuideDto' },
        },
        reassurance: { type: 'string', nullable: true },
      },
    });
  });
  it('enforces JWT, owner and expiry outside development', async () => {
    config.set('NODE_ENV', 'production');
    const path = `/api/analysis/${id}/summary`;
    const get = () => request(app.getHttpServer()).get(path);
    const databaseRow = {
      id,
      userId: 'owner',
      expiresAt: new Date(Date.now() + 60000),
      summaryStatus: 'PENDING',
    };
    prisma.analysis.findFirst.mockImplementation(async ({ where }) =>
      where.id === databaseRow.id &&
      where.userId === databaseRow.userId &&
      where.expiresAt.gt < databaseRow.expiresAt
        ? databaseRow
        : null,
    );
    try {
      await get().expect(401);
      await get().set('Authorization', 'Bearer invalid').expect(401);
      await get()
        .set('Authorization', `Bearer ${token('other')}`)
        .expect(404);
      await get()
        .set('Authorization', `Bearer ${token('owner')}`)
        .expect(200);
      databaseRow.expiresAt = new Date(0);
      await get()
        .set('Authorization', `Bearer ${token('owner')}`)
        .expect(404);
    } finally {
      prisma.analysis.findFirst.mockReset();
      config.set('NODE_ENV', 'development');
    }
  });

  it('rejects malformed UUID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/analysis/bad/summary')
      .expect(400);
    expect(response.body.code).toBe('COMMON400');
  });
  it('returns 404 for missing/unauthorized/expired rows', async () => {
    prisma.analysis.findFirst.mockResolvedValue(null);
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}/summary`)
      .expect(404);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: 'COMMON404',
      result: null,
    });
  });
});
