import { configureAnalysisSwagger } from '../src/domains/analysis/analysis.swagger';
import { randomUUID } from 'node:crypto';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';

const dbDescribe = process.env.TEXT13_DB_URL ? describe : describe.skip;
dbDescribe('#13 actual PostgreSQL verification (isolated test DB only)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const ai = {
    analyze: jest.fn(() => {
      throw Error('TEXT must not call IMAGE provider');
    }),
  };
  const usage = { reserveAiUsage: jest.fn(), releaseAiUsage: jest.fn() };
  let logs: jest.SpyInstance[];
  const post = (text: unknown) =>
    request(app.getHttpServer())
      .post('/api/analysis')
      .send({ type: 'TEXT', text });
  beforeAll(async () => {
    const url = new URL(process.env.TEXT13_DB_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^pb23_test_\d+$/.test(url.pathname.slice(1))
    )
      throw Error('Isolated database required');
    logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (method) =>
        jest.spyOn(Logger.prototype, method).mockImplementation(() => {}),
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          NODE_ENV: 'development',
          ANALYSIS_MAX_FILE_BYTES: '100000',
          ANALYSIS_RETENTION_SECONDS: '86400',
          AI_REQUEST_TIMEOUT_MS: '100',
        }),
      )
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue(ai)
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
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    logs?.forEach((log) => log.mockRestore());
  });
  it.each([5, 3000])(
    'persists %i-character input as UUID/TEXT/QUEUED with exact 30-day retention',
    async (length) => {
      const response = await post('가'.repeat(length)).expect(202);
      expect(response.body).toMatchObject({
        isSuccess: true,
        code: 'ANALYSIS202',
        result: { type: 'TEXT', status: 'QUEUED' },
      });
      expect(response.body.result.analysisId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const row = await prisma.analysis.findUniqueOrThrow({
        where: { id: response.body.result.analysisId },
        include: { modelResults: true },
      });
      expect(row.status).toBe('QUEUED');
      expect(row.type).toBe('TEXT');
      expect(row.updatedAt).toEqual(row.createdAt);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
        30 * 24 * 60 * 60 * 1000,
      );
      expect(Array.from(row.textPreview!)).toHaveLength(Math.min(length, 200));
      expect(row.modelResults).toHaveLength(0);
      expect(row.aiGenerationScore).toBeNull();
      expect(row.aiRiskLevel).toBeNull();
      expect(row.reasons).toBeNull();
      expect(row.completedAt).toBeNull();
      expect(ai.analyze).not.toHaveBeenCalled();
      expect(usage.reserveAiUsage).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['4 characters', 'abcd'],
    ['3001 characters', 'a'.repeat(3001)],
    ['empty', ''],
    ['whitespace', ' \n\t '],
    ['number', 12345],
    ['null', null],
    ['object', { text: 'abcde' }],
    ['missing', undefined],
    ['array', ['abcde']],
    ['trimmed short', '  abcd  '],
  ])('rejects %s without any DB writes', async (_label, text) => {
    const before = await prisma.analysis.count();
    const models = await prisma.analysisModelResult.count();
    const response = await post(text).expect(400);
    expect(response.body).toMatchObject({
      isSuccess: false,
      code: 'COMMON400',
      result: null,
    });
    expect(await prisma.analysis.count()).toBe(before);
    expect(await prisma.analysisModelResult.count()).toBe(models);
  });
  it('trims before storing, never stores the original suffix, and does not log input', async () => {
    const marker = 'not-for-log-' + randomUUID();
    const original = 'x'.repeat(200) + marker;
    const response = await post('  ' + original + ' \n').expect(202);
    const row = await prisma.analysis.findUniqueOrThrow({
      where: { id: response.body.result.analysisId },
      include: { modelResults: true },
    });
    expect(row.textPreview).toBe('x'.repeat(200));
    expect(row.modelResults).toHaveLength(0);
    expect(JSON.stringify(row)).not.toContain(marker);
    expect(JSON.stringify(response.body)).not.toContain(marker);
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(
      marker,
    );
    const columns = await prisma.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='analysis_requests'`;
    expect(
      columns.some((c) =>
        ['text', 'originalText', 'rawText'].includes(c.column_name),
      ),
    ).toBe(false);
    const trimmed = await post('  abcde \n').expect(202);
    expect(trimmed.body.result.textPreview).toBe('abcde');
  });
  it('enforces expiry equality and ownership against actual rows', async () => {
    const response = await post('이력 조회 검증용 텍스트').expect(202);
    const id = response.body.result.analysisId;
    const repository = app.get(AnalysisRepository);
    const row = await prisma.analysis.findUniqueOrThrow({ where: { id } });
    expect(
      await repository.findActiveTextForUser(
        id,
        'development-user',
        new Date(row.expiresAt.getTime() - 1),
      ),
    ).not.toBeNull();
    expect(
      await repository.findActiveTextForUser(
        id,
        'development-user',
        row.expiresAt,
      ),
    ).toBeNull();
    expect(
      await repository.findActiveTextForUser(id, 'other-user', row.createdAt),
    ).toBeNull();
  });
  it('tracks Prisma updates and preserves historical rows through the migration', async () => {
    const baseline = await prisma.analysis.findUniqueOrThrow({
      where: { id: '00000000-0000-4000-8000-000000000013' },
    });
    expect(baseline.updatedAt).toEqual(baseline.createdAt);
    expect(baseline.textPreview).toBeNull();
    expect(baseline.requestHash).toBe('baseline');
    const id = randomUUID(),
      createdAt = new Date('2026-01-01');
    await prisma.analysis.create({
      data: {
        id,
        userId: 'verify-update',
        type: 'TEXT',
        requestHash: 'verify',
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date('2099-01-01'),
      },
    });
    const updated = await prisma.analysis.update({
      where: { id },
      data: { textPreview: 'updated preview' },
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(createdAt.getTime());
  });
  it.each([
    ['NUL', 'ab\u0000cd'],
    ['unpaired surrogate', 'ab\ud800cd'],
  ])(
    'reproduces the known PostgreSQL-incompatible %s input issue as COMMON500',
    async (_label, text) => {
      const before = await prisma.analysis.count();
      const response = await post(text);
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('COMMON500');
      expect(await prisma.analysis.count()).toBe(before);
    },
  );
  it('documents distinct JSON and multipart contracts after the Swagger fix', () => {
    const doc = configureAnalysisSwagger(
      SwaggerModule.createDocument(app, new DocumentBuilder().build()),
    );
    const body = doc.paths['/api/analysis'].post!
      .requestBody as import('@nestjs/swagger').RequestBodyObject;
    expect(body.content['application/json'].schema).toMatchObject({
      required: ['type', 'text'],
      properties: {
        type: { enum: ['TEXT'] },
        sourceType: { enum: ['DIRECT'] },
        text: { minLength: 5, maxLength: 3000 },
      },
    });
    expect(body.content['multipart/form-data'].schema).toMatchObject({
      required: ['type', 'file'],
      properties: {
        type: { enum: ['IMAGE', 'TEXT'] },
        sourceType: { enum: ['SCREEN_CROP'] },
        file: { type: 'string', format: 'binary' },
      },
    });
    expect(body.content['application/json'].schema).not.toEqual(
      body.content['multipart/form-data'].schema,
    );
  });
});
