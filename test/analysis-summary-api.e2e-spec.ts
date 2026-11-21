const jwt = (sub = 'development-user') => {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  return `${h}.${p}.${createHmac('sha256', 'photo-review-secret').update(`${h}.${p}`).digest('base64url')}`;
};
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID, createHmac } from 'node:crypto';
import { AnalysisController } from '../src/domains/analysis/analysis.controller';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { AnalysisSummaryRepository } from '../src/domains/analysis/analysis-summary.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { UploadedImageCleanupInterceptor } from '../src/domains/analysis/uploaded-image-cleanup.interceptor';

describe('summary HTTP API', () => {
  let app: INestApplication;
  const id = randomUUID();
  const prisma = { analysis: { findFirst: jest.fn() } };
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
          useValue: new ConfigService({
            JWT_ACCESS_SECRET: 'photo-review-secret',
          }),
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
        .set('Authorization', `Bearer ${jwt()}`)
        .expect(200);
      expect(response.body).toMatchObject({
        isSuccess: true,
        code: 'ANALYSIS200',
        result: {
          analysisId: id,
          summaryStatus: status,
          summary: status === 'COMPLETED' ? 'stored' : null,
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
  it('rejects malformed UUID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/analysis/bad/summary')
      .set('Authorization', `Bearer ${jwt()}`)
      .expect(400);
    expect(response.body.code).toBe('COMMON400');
  });
  it('returns 404 for missing/unauthorized/expired rows', async () => {
    prisma.analysis.findFirst.mockResolvedValue(null);
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}/summary`)
      .set('Authorization', `Bearer ${jwt()}`)
      .expect(404);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: 'COMMON404',
      result: null,
    });
  });
});
