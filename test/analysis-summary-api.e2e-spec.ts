import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
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
        { provide: ConfigService, useValue: new ConfigService() },
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
