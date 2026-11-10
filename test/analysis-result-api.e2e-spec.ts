import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AnalysisController } from '../src/domains/analysis/analysis.controller';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { AnalysisSummaryRepository } from '../src/domains/analysis/analysis-summary.repository';
import { ImageAnalysisService } from '../src/domains/analysis/image-analysis.service';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { UploadedImageCleanupInterceptor } from '../src/domains/analysis/uploaded-image-cleanup.interceptor';

const id = randomUUID();
const model = (kind: 'GENERATION' | 'MANIPULATION') => ({
  id: randomUUID(),
  analysisId: id,
  kind,
  modelName: kind === 'GENERATION' ? 'CuRe' : 'TruFor',
  modelVersion: 'mock-v0.2',
  policyVersion: 'mock-pilot-v0.2',
  status: 'SUCCEEDED',
  decision:
    kind === 'GENERATION'
      ? 'AI_GENERATED_SUSPECTED'
      : 'NO_CLEAR_MANIPULATION_SIGNAL',
  displayScore: kind === 'GENERATION' ? 80 : 10,
  reasons: [{ description: '가상 근거', rawScore: 'private' }],
  limitations: ['MOCK'],
  errorCode: null,
  retryable: null,
  rawScore: 'private',
  localization: 'private',
});
const row = () => ({
  id,
  userId: 'development-user',
  requestHash: 'private',
  type: 'IMAGE',
  status: 'COMPLETED',
  imageResultStatus: 'COMPLETED',
  aiGenerationScore: 80,
  aiRiskLevel: null,
  reasons: [{ description: '가상 근거', rawScore: 'private' }],
  modelVersion: 'mock-v0.2',
  errorCode: null,
  createdAt: new Date(),
  completedAt: new Date(),
  expiresAt: new Date(Date.now() + 60000),
  summary: 'separate-summary',
  summaryStatus: 'COMPLETED',
  summaryModel: 'private',
  summarizedAt: new Date(),
  modelResults: [model('GENERATION'), model('MANIPULATION')],
});
describe('analysis result GET API', () => {
  let app: INestApplication;
  const repository = { findWithModelResults: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AnalysisController],
      providers: [
        AnalysisService,
        UploadedImageCleanupInterceptor,
        { provide: AnalysisRepository, useValue: repository },
        { provide: AnalysisSummaryRepository, useValue: {} },
        { provide: ImageAnalysisService, useValue: {} },
        { provide: AnalysisUsageService, useValue: {} },
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
  beforeEach(() => {
    jest.clearAllMocks();
    repository.findWithModelResults.mockResolvedValue(row());
  });
  afterAll(async () => {
    await app.close();
  });
  it('returns existing fields and safe model projections, with summary kept separate', async () => {
    const stored = row();
    repository.findWithModelResults.mockResolvedValue(stored);
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}`)
      .expect(200);
    expect(repository.findWithModelResults).toHaveBeenCalledWith(id);
    expect(response.body).toMatchObject({
      isSuccess: true,
      code: 'ANALYSIS200',
      result: {
        analysisId: id,
        type: stored.type,
        status: stored.status,
        aiGenerationScore: 80,
        aiRiskLevel: null,
        reasons: [{ description: '가상 근거' }],
        modelVersion: stored.modelVersion,
        errorCode: null,
        createdAt: stored.createdAt.toISOString(),
        completedAt: stored.completedAt.toISOString(),
        expiresAt: stored.expiresAt.toISOString(),
        models: {
          status: 'COMPLETED',
          generation: { modelName: 'CuRe', displayScore: 80 },
          manipulation: { modelName: 'TruFor', displayScore: 10 },
        },
        overallResult: { decision: 'GENERATION_OR_MANIPULATION_SUSPECTED' },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /rawScore|localization|private|summary|userId|requestHash/,
    );
  });
  it('rejects invalid UUID before DB access', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/analysis/invalid')
      .expect(400);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: 'COMMON400',
      result: null,
    });
    expect(repository.findWithModelResults).not.toHaveBeenCalled();
  });
  it.each(['missing', 'other-user', 'expired'])(
    'returns COMMON404 for %s',
    async (type) => {
      repository.findWithModelResults.mockResolvedValue(
        type === 'missing'
          ? null
          : {
              ...row(),
              ...(type === 'other-user'
                ? { userId: 'other' }
                : { expiresAt: new Date(0) }),
            },
      );
      const response = await request(app.getHttpServer())
        .get(`/api/analysis/${id}`)
        .expect(404);
      expect(response.body).toMatchObject({
        isSuccess: false,
        code: 'COMMON404',
        result: null,
      });
    },
  );
  it('uses the common filter for DB failures', async () => {
    repository.findWithModelResults.mockRejectedValueOnce(
      new Error('private DB detail'),
    );
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}`)
      .expect(500);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: 'COMMON500',
      result: null,
    });
    expect(response.body.message).not.toContain('private');
  });
  it.each(['QUEUED', 'ANALYZING', 'FAILED'])(
    'handles %s without model results',
    async (status) => {
      repository.findWithModelResults.mockResolvedValue({
        ...row(),
        status,
        modelResults: [],
        imageResultStatus: null,
        completedAt: null,
      });
      const response = await request(app.getHttpServer())
        .get(`/api/analysis/${id}`)
        .expect(200);
      expect(response.body.result).toMatchObject({
        status,
        completedAt: null,
        models: null,
        overallResult: { decision: 'INCONCLUSIVE' },
      });
    },
  );
  it.each([
    [
      'suspected',
      'AI_GENERATED_SUSPECTED',
      'SUCCEEDED',
      'NO_CLEAR_MANIPULATION_SIGNAL',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      '출처',
    ],
    [
      'clear',
      'NO_CLEAR_GENERATION_SIGNAL',
      'SUCCEEDED',
      'NO_CLEAR_MANIPULATION_SIGNAL',
      'NO_CLEAR_SIGNAL',
      '원본 사진이거나 안전한',
    ],
    [
      'inconclusive',
      'INCONCLUSIVE',
      'SUCCEEDED',
      'NO_CLEAR_MANIPULATION_SIGNAL',
      'INCONCLUSIVE',
      '판단하기 어렵',
    ],
    [
      'failed',
      'NO_CLEAR_GENERATION_SIGNAL',
      'FAILED',
      null,
      'INCONCLUSIVE',
      '변조 분석에 실패',
    ],
  ])(
    'normalizes %s without conflating risk or summary status',
    async (
      _name,
      generationDecision,
      manipulationStatus,
      manipulationDecision,
      expected,
      guide,
    ) => {
      const stored = row();
      Object.assign(stored.modelResults[0], {
        decision: generationDecision,
        displayScore: null,
        reasons: [
          { description: ' 근거 ' },
          { description: '근거' },
          { description: ' ' },
        ],
        limitations: [' 한계 ', '한계', ''],
      });
      Object.assign(stored.modelResults[1], {
        status: manipulationStatus,
        decision: manipulationDecision,
        displayScore: null,
        reasons: null,
        limitations: null,
      });
      repository.findWithModelResults.mockResolvedValue(stored);
      const response = await request(app.getHttpServer())
        .get(`/api/analysis/${id}`)
        .expect(200);
      expect(response.body.result).toMatchObject({
        aiRiskLevel: null,
        overallResult: { decision: expected },
        models: {
          generation: {
            displayScore: null,
            reasons: [{ description: '근거' }],
            limitations: ['한계'],
          },
          manipulation: { displayScore: null, reasons: [], limitations: [] },
        },
      });
      expect(response.body.result.guides.join(' ')).toContain(guide);
      for (const summaryStatus of ['PENDING', 'COMPLETED', 'FAILED']) {
        stored.summaryStatus = summaryStatus;
        const again = await request(app.getHttpServer())
          .get(`/api/analysis/${id}`)
          .expect(200);
        expect(again.body).toEqual(response.body);
      }
    },
  );
  it('normalizes both failed models and does not present stale reasons as evidence', async () => {
    const stored = row();
    for (const model of stored.modelResults)
      Object.assign(model, { status: 'FAILED', errorCode: 'MODEL_FAILED' });
    repository.findWithModelResults.mockResolvedValue(stored);
    const response = await request(app.getHttpServer())
      .get(`/api/analysis/${id}`)
      .expect(200);
    for (const model of [
      response.body.result.models.generation,
      response.body.result.models.manipulation,
    ]) {
      expect(model).toMatchObject({
        status: 'FAILED',
        decision: null,
        displayScore: null,
        reasons: [],
        errorCode: 'MODEL_FAILED',
      });
    }
    expect(response.body.result.overallResult.decision).toBe('INCONCLUSIVE');
    expect(response.body.result.guides.join(' ')).toContain(
      'AI 생성 분석에 실패',
    );
    expect(response.body.result.guides.join(' ')).toContain(
      '이미지 변조 분석에 실패',
    );
  });
  it('documents result and existing summary as separate endpoints', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(doc.paths['/api/analysis/{analysisId}/summary'].get).toBeDefined();
    expect(
      Object.keys(doc.paths['/api/analysis/{analysisId}'].get!.responses),
    ).toEqual(expect.arrayContaining(['200', '400', '404', '500']));
    expect(doc.components!.schemas!.AnalysisResultDto).toMatchObject({
      properties: {
        analysisId: expect.any(Object),
        aiGenerationScore: expect.any(Object),
        models: expect.any(Object),
        overallResult: expect.any(Object),
        guides: expect.objectContaining({
          type: 'array',
          items: { type: 'string' },
        }),
      },
    });
  });
});
