import sharp from 'sharp';
import { TextAiWorkflowService } from '../src/domains/analysis/text-ai-workflow.service';
import { TEXT_ANALYSIS_PROVIDER } from '../src/domains/analysis/http-text-analysis.provider';
import { textWire } from './fixtures/text-risk';
import { configureAnalysisSwagger } from '../src/domains/analysis/analysis.swagger';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AnalysisController } from '../src/domains/analysis/analysis.controller';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { ImageAnalysisService } from '../src/domains/analysis/image-analysis.service';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { RequestUserGuard } from '../src/common/auth/request-user.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  AnalysisWithResults,
  mapAnalysisResult,
} from '../src/domains/analysis/analysis-result.mapper';

const secret = 'normalization-test-secret';
function token(user = 'owner') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({ sub: user, exp: Date.now() / 1000 + 300 }),
  ).toString('base64url');
  return `Bearer ${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
function row(): AnalysisWithResults {
  return {
    id: randomUUID(),
    userId: 'owner',
    type: 'IMAGE',
    status: 'COMPLETED',
    requestHash: 'private',
    idempotencyKey: null,
    aiGenerationScore: 80,
    aiRiskLevel: null,
    reasons: [{ description: '저장된 이미지 근거' }],
    modelVersion: 'v1',
    errorCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    textPreview: null,
    textResult: null,
    imageResultStatus: null,
    modelResults: [],
    summary: null,
    summaryStatus: null,
    summaryModel: null,
    summarizedAt: null,
  };
}
function textRow(sourceType = 'TEXT'): AnalysisWithResults {
  const value = row();
  return {
    ...value,
    type: sourceType === 'TEXT' ? 'TEXT' : 'IMAGE',
    textResult: {
      analysisId: value.id,
      sourceType,
      decision: 'phishing',
      riskScore: 0.92,
      scoreScale: '0..1',
      scoreMeaning: 'UNCALIBRATED_CLASSIFIER_SCORE',
      evidence: ['비저장 자유문구'],
      text: '원문 비노출',
    },
  };
}

describe('PB-05 normalized analysis projection', () => {
  it('keeps IMAGE scores separate and preserves legacy fields', () => {
    const value = row();
    expect(mapAnalysisResult(value)).toMatchObject({
      analysisId: value.id,
      aiGenerationScore: 80,
      reasons: value.reasons,
      result: {
        riskLevel: 'UNKNOWN',
        textDecision: null,
        riskScore: null,
        reasons: ['저장된 이미지 근거'],
        guidance: [],
        summary: null,
      },
    });
  });
  it.each(['TEXT', 'SCREEN_CROP', 'IMAGE'])(
    'maps saved TEXT contract source %s without exposing text/evidence',
    (source) => {
      const result = mapAnalysisResult(textRow(source));
      expect(result).toMatchObject({
        sourceType: source,
        result: { riskLevel: 'UNKNOWN', riskScore: 0.92, scoreScale: '0..1' },
      });
      expect(JSON.stringify(result)).not.toContain('비저장 자유문구');
      expect(JSON.stringify(result)).not.toContain('원문 비노출');
      if (source === 'TEXT') expect(result.result.reasons).toEqual([]);
    },
  );
  it.each(['QUEUED', 'ANALYZING', 'FAILED'] as const)(
    'does not invent results for %s even with stale stored data',
    (status) => {
      const value = textRow();
      value.status = status;
      value.summaryStatus = 'COMPLETED';
      value.summary = 'stale';
      expect(mapAnalysisResult(value).result).toEqual({
        riskLevel: 'UNKNOWN',
        textDecision: null,
        riskScore: null,
        scoreScale: null,
        scoreMeaning: null,
        reasons: [],
        guidance: [],
        summary: null,
      });
    },
  );
  it.each([null, -1, 2])(
    'handles unavailable/invalid TEXT score %s',
    (riskScore) => {
      const value = textRow();
      (value.textResult as Record<string, any>).riskScore = riskScore;
      expect(mapAnalysisResult(value).result.riskScore).toBeNull();
    },
  );
  it('preserves defer as a model decision without assigning a risk level', () => {
    const value = textRow();
    (value.textResult as Record<string, any>).decision = 'defer';
    expect(mapAnalysisResult(value).result).toMatchObject({
      riskLevel: 'UNKNOWN',
      reasons: [],
      riskScore: 0.92,
      textDecision: 'defer',
    });
  });
  it('tolerates missing and malformed reasons', () => {
    const value = row();
    value.reasons = [null, {}, { description: 3 }];
    expect(mapAnalysisResult(value).result.reasons).toEqual([]);
  });
  it.each(['GENERATION', 'MANIPULATION'] as const)(
    'excludes failed %s reasons and retains successful model reasons',
    (kind) => {
      const value = row();
      value.imageResultStatus = 'PARTIAL_FAILED';
      const model = {
        id: randomUUID(),
        analysisId: value.id,
        kind,
        status: 'FAILED' as const,
        displayScore: null,
        decision: null,
        reasons: [{ description: '실패 모델 근거' }],
        limitations: [],
        modelName: 'model',
        modelVersion: 'v1',
        policyVersion: 'v1',
        errorCode: 'AI_FAILED',
        retryable: true,
      };
      value.modelResults = [
        model,
        {
          ...model,
          id: randomUUID(),
          kind: kind === 'GENERATION' ? 'MANIPULATION' : 'GENERATION',
          status: 'SUCCEEDED',
          decision: 'INCONCLUSIVE',
          reasons: [{ description: '성공 모델 근거' }],
          errorCode: null,
        },
      ];
      expect(mapAnalysisResult(value).result).toMatchObject({
        riskLevel: 'UNKNOWN',
        textDecision: null,
        riskScore: null,
        reasons: ['성공 모델 근거'],
      });
    },
  );
  it.each([null, 'PENDING', 'FAILED', 'COMPLETED'] as const)(
    'only includes completed stored summary (%s)',
    (summaryStatus) => {
      const value = row();
      value.summaryStatus = summaryStatus;
      value.summary = '저장된 요약';
      expect(mapAnalysisResult(value).result.summary).toBe(
        summaryStatus === 'COMPLETED' ? '저장된 요약' : null,
      );
      expect(mapAnalysisResult(value).status).toBe('COMPLETED');
    },
  );
});

describe('authenticated GET /api/analysis/:analysisId', () => {
  let app: INestApplication;
  let value: AnalysisWithResults;
  const findFirst = jest.fn();
  const create = jest.fn();
  let environment = 'production';
  let textMode = 'disabled';
  const update = jest.fn();
  const textProvider = { analyze: jest.fn(), analyzeImage: jest.fn() };
  const image = { analyze: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AnalysisController],
      providers: [
        AnalysisService,
        TextAiWorkflowService,
        { provide: TEXT_ANALYSIS_PROVIDER, useValue: textProvider },
        AnalysisRepository,
        RequestUserGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              name === 'JWT_ACCESS_SECRET'
                ? secret
                : name === 'NODE_ENV'
                  ? environment
                  : name === 'TEXT_AI_PROVIDER'
                    ? textMode
                    : name === 'ANALYSIS_MAX_FILE_BYTES'
                      ? '100000'
                      : name === 'AI_REQUEST_TIMEOUT_MS'
                        ? '1000'
                        : undefined,
          },
        },
        {
          provide: PrismaService,
          useValue: { analysis: { findFirst, create, update } },
        },
        { provide: ImageAnalysisService, useValue: image },
        { provide: AnalysisUsageService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  beforeEach(() => {
    value = row();
    environment = 'production';
    textMode = 'disabled';
    jest.clearAllMocks();
    update.mockImplementation(async ({ data }) => {
      Object.assign(value, data);
      return value;
    });
    textProvider.analyzeImage.mockImplementation(async (_file, context) =>
      textWire(context.analysisId, context.elementId, 'SCREEN_CROP'),
    );
    create.mockImplementation(async ({ data }) => {
      value = { ...row(), ...data, status: 'QUEUED' };
      return value;
    });
    findFirst.mockImplementation(async ({ where }) =>
      value.id === where.id &&
      value.userId === where.userId &&
      value.expiresAt > where.expiresAt.gt
        ? value
        : null,
    );
  });
  afterAll(() => app.close());
  const get = (id: string) =>
    request(app.getHttpServer()).get(`/api/analysis/${id}`);
  it('uses the same development identity from POST through GET without a token', async () => {
    environment = 'development';
    const post = await request(app.getHttpServer())
      .post('/api/analysis')
      .send({ type: 'TEXT', text: '개발 환경 분석 요청' })
      .expect(202);
    expect(value.userId).toBe('development-user');
    const result = await get(post.body.result.analysisId).expect(200);
    expect(result.body.result).toMatchObject({
      analysisId: value.id,
      status: 'QUEUED',
      sourceType: 'TEXT',
    });
    expect(findFirst).toHaveBeenLastCalledWith({
      where: {
        id: value.id,
        userId: 'development-user',
        expiresAt: { gt: expect.any(Date) },
      },
      include: { modelResults: true },
    });
  });
  it('queries SCREEN_CROP saved by the explicit public POST contract', async () => {
    environment = 'development';
    textMode = 'http';
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const post = await request(app.getHttpServer())
      .post('/api/analysis')
      .field('type', 'TEXT')
      .field('sourceType', 'SCREEN_CROP')
      .attach('file', bytes, 'capture.png')
      .expect(202);
    const result = await get(post.body.result.analysisId).expect(200);
    expect(result.body.result).toMatchObject({
      type: 'TEXT',
      sourceType: 'SCREEN_CROP',
      result: {
        riskLevel: 'UNKNOWN',
        riskScore: 0.82,
        reasons: [],
        guidance: [],
      },
    });
    expect(textProvider.analyzeImage).toHaveBeenCalledTimes(1);
    expect(textProvider.analyze).not.toHaveBeenCalled();
    expect(image.analyze).not.toHaveBeenCalled();
  });
  it.each(['QUEUED', 'ANALYZING', 'FAILED'] as const)(
    'preserves SCREEN_CROP source for %s without inventing results',
    async (status) => {
      value.status = status;
      value.textResult = { sourceType: 'SCREEN_CROP' };
      value.type = 'TEXT';
      const result = await get(value.id)
        .set('Authorization', token())
        .expect(200);
      expect(result.body.result).toMatchObject({
        sourceType: 'SCREEN_CROP',
        status,
        result: {
          riskLevel: 'UNKNOWN',
          riskScore: null,
          textDecision: null,
          reasons: [],
          guidance: [],
          summary: null,
        },
      });
    },
  );
  it('uses development-user even when a different Bearer identity is supplied', async () => {
    environment = 'development';
    value.userId = 'development-user';
    await get(value.id).expect(200);
    await get(value.id).set('Authorization', token('other')).expect(200);
  });
  it('still blocks other-user and expired records in development', async () => {
    environment = 'development';
    await get(value.id).expect(404);
    value.userId = 'development-user';
    value.expiresAt = new Date(0);
    await get(value.id).expect(404);
  });
  it('requires JWT for POST in production and uses JWT subject for creation', async () => {
    await request(app.getHttpServer())
      .post('/api/analysis')
      .send({ type: 'TEXT', text: '운영 환경 분석 요청' })
      .expect(401);
    expect(create).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post('/api/analysis')
      .set('Authorization', token())
      .send({ type: 'TEXT', text: '운영 환경 분석 요청' })
      .expect(202);
    expect(value.userId).toBe('owner');
    await get(value.id).set('Authorization', token()).expect(200);
  });
  it.each(['test', 'staging', '', undefined])(
    'fails closed for environment %s',
    async (mode) => {
      environment = mode as string;
      await get(value.id).expect(401);
      expect(findFirst).not.toHaveBeenCalled();
    },
  );
  it('never bypasses auth under process NODE_ENV=production even with conflicting config', async () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      environment = 'development';
      await get(value.id).expect(401);
      expect(findFirst).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  it('returns wrapper and stored projection repeatedly without AI calls', async () => {
    const first = await get(value.id).set('Authorization', token()).expect(200);
    const second = await get(value.id)
      .set('Authorization', token())
      .expect(200);
    expect(first.body).toEqual(second.body);
    expect(first.body).toMatchObject({
      isSuccess: true,
      code: 'ANALYSIS200',
      result: { analysisId: value.id },
    });
    expect(first.body.result).not.toHaveProperty('requestHash');
    expect(image.analyze).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: value.id,
        userId: 'owner',
        expiresAt: { gt: expect.any(Date) },
      },
      include: { modelResults: true },
    });
  });
  it('rejects missing/invalid token before reading storage', async () => {
    await get(value.id).expect(401);
    await get(value.id).set('Authorization', 'Bearer invalid').expect(401);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it('rejects malformed UUID', async () => {
    const res = await get('invalid').set('Authorization', token()).expect(400);
    expect(res.body.code).toBe('COMMON400');
  });
  it('hides missing, other-user and expired records identically', async () => {
    const missing = await get(randomUUID())
      .set('Authorization', token())
      .expect(404);
    const other = await get(value.id)
      .set('Authorization', token('other'))
      .expect(404);
    value.expiresAt = new Date(0);
    const expired = await get(value.id)
      .set('Authorization', token())
      .expect(404);
    expect(other.body).toEqual(missing.body);
    expect(expired.body).toEqual(missing.body);
  });
  it('does not leak database errors', async () => {
    findFirst.mockRejectedValueOnce(new Error('private connection'));
    const res = await get(value.id).set('Authorization', token()).expect(500);
    expect(res.body.code).toBe('COMMON500');
    expect(JSON.stringify(res.body)).not.toContain('private');
  });
  it('documents GET and POST bearer auth and common result', () => {
    const doc = configureAnalysisSwagger(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().addBearerAuth().build(),
      ),
    );
    const operation = doc.paths['/api/analysis/{analysisId}'].get!;
    expect(operation.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '500']),
    );
    expect(doc.components?.schemas?.NormalizedAnalysisResultDto).toBeDefined();
    expect(doc.paths['/api/analysis'].post!.security).toEqual([{ bearer: [] }]);
  });
});
