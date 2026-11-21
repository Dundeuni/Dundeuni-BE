const secret = 'review-test-secret';
const token = (
  sub = 'development-user',
  exp = Math.floor(Date.now() / 1000) + 3600,
) => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString(
    'base64url',
  );
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
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
            NODE_ENV: 'production',
            JWT_ACCESS_SECRET: secret,
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
  it.each([
    undefined,
    'Bearer invalid',
    `Bearer ${token('development-user', 1)}`,
  ])('rejects missing, invalid or expired JWT: %s', async (authorization) => {
    for (const suffix of ['', '/summary']) {
      const req = request(app.getHttpServer()).get(
        `/api/analysis/${id}${suffix}`,
      );
      if (authorization) req.set('Authorization', authorization);
      const response = await req.expect(401);
      expect(response.body.code).toBe('AUTH401');
    }
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
        .set('Authorization', `Bearer ${token()}`)
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
  it.each(['bob', 'expired'])(
    'does not disclose a summary owned by %s',
    async (caseName) => {
      prisma.analysis.findFirst.mockImplementation(async ({ where }) =>
        where.userId === 'alice' && caseName !== 'expired'
          ? { id, summaryStatus: 'COMPLETED', summary: 'private' }
          : null,
      );
      const response = await request(app.getHttpServer())
        .get(`/api/analysis/${id}/summary`)
        .set(
          'Authorization',
          `Bearer ${token(caseName === 'bob' ? 'bob' : 'alice')}`,
        )
        .expect(404);
      expect(response.body.code).toBe('COMMON404');
      expect(prisma.analysis.findFirst).toHaveBeenLastCalledWith({
        where: {
          id,
          userId: caseName === 'bob' ? 'bob' : 'alice',
          expiresAt: { gt: expect.any(Date) },
        },
      });
    },
  );
  it('rejects malformed UUID', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/analysis/bad/summary')
      .set('Authorization', `Bearer ${token()}`)
      .expect(400);
    expect(response.body.code).toBe('COMMON400');
  });
  it('returns 404 for missing/unauthorized/expired rows', async () => {
    prisma.analysis.findFirst.mockResolvedValue(null);
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}/summary`)
      .set('Authorization', `Bearer ${token()}`)
      .expect(404);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: 'COMMON404',
      result: null,
    });
  });
});
