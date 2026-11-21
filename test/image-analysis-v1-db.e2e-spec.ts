import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { MockScenario } from '../src/domains/analysis/mock-image-analysis.provider';
import { PNG } from 'pngjs';
import { parse } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { calculateOverallResult } from '../src/domains/analysis/image-analysis-policy';
import { ConfigService } from '@nestjs/config';
import { AnalysisService } from '../src/domains/analysis/analysis.service';
import { ImageAnalysisService } from '../src/domains/analysis/image-analysis.service';
import { MockImageAnalysisProvider } from '../src/domains/analysis/mock-image-analysis.provider';
import { AnalysisUsageService } from '../src/domains/analysis/analysis-usage.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { ImageModelPublicResultDto } from '../src/domains/analysis/image-analysis-v1.dto';

const dbDescribe = process.env.V1_DB_TEST === '1' ? describe : describe.skip;
dbDescribe('V1 Prisma storage in isolated local schema', () => {
  const schema = `v1_test_${randomUUID().replaceAll('-', '')}`;
  let prisma: PrismaClient;
  let app: INestApplication;
  let scenario: MockScenario = 'BOTH_SUCCESS';
  const usage = {
    reserveAiUsage: jest.fn(async () => {}),
    releaseAiUsage: jest.fn(async () => {}),
  };
  const provider = {
    analyze: jest.fn((file, context, signal) =>
      new MockImageAnalysisProvider(scenario).analyze(file, context, signal),
    ),
  };
  let repository: AnalysisRepository;
  let connection: URL;
  function sql(text: string) {
    return execFileSync(
      process.env.PSQL_PATH ?? '/opt/homebrew/opt/postgresql@17/bin/psql',
      [
        '-h',
        connection.hostname,
        '-p',
        connection.port || '5432',
        '-U',
        decodeURIComponent(connection.username),
        '-d',
        connection.pathname.slice(1),
        '-v',
        'ON_ERROR_STOP=1',
      ],
      {
        input: text,
        env: {
          ...process.env,
          PGPASSWORD: decodeURIComponent(connection.password),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  }
  beforeAll(async () => {
    connection = new URL(
      process.env.PB23_DB_URL ?? parse(readFileSync('.env')).DATABASE_URL,
    );
    if (
      process.env.PB23_DB_URL &&
      !/^pb23_test_\d+$/.test(connection.pathname.slice(1))
    )
      throw new Error('PB23 isolated database required');
    if (!['localhost', '127.0.0.1'].includes(connection.hostname))
      throw new Error('Local test database required');
    const migrations = readdirSync('prisma/migrations')
      .filter((name) => /^\d/.test(name))
      .sort();
    const scoped = migrations
      .map((name) =>
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      )
      .join('\n')
      .replaceAll('"public"', `"${schema}"`);
    sql(
      `BEGIN; CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; ${scoped} COMMIT;`,
    );
    connection.searchParams.set('schema', schema);
    prisma = new PrismaClient({ datasourceUrl: connection.toString() });
    repository = new AnalysisRepository(prisma as unknown as PrismaService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          NODE_ENV: 'development',
          ANALYSIS_MAX_FILE_BYTES: '1024',
          ANALYSIS_RETENTION_SECONDS: '86400',
          AI_REQUEST_TIMEOUT_MS: '100',
        }),
      )
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AnalysisUsageService)
      .useValue(usage)
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue(provider)
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
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    if (connection) sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });
  const result = (failed = false): ImageModelPublicResultDto => ({
    status: failed ? 'FAILED' : 'SUCCEEDED',
    modelName: 'test',
    modelVersion: '1',
    policyVersion: '1',
    displayScore: failed ? null : 80,
    decision: failed ? null : 'INCONCLUSIVE',
    reasons: [{ description: 'test' }],
    limitations: ['test'],
    errorCode: failed ? 'MODEL_FAILED' : null,
    retryable: null,
  });
  it('keeps old rows compatible, saves partial results and preserves unrequested model', async () => {
    const row = await repository.create(
      'test-user',
      'test-hash',
      new Date(Date.now() + 10000),
    );
    expect(row.summaryStatus).toBeNull();
    expect(row.aiGenerationScore).toBeNull();
    await repository.saveModelResults(row.id, {
      status: 'PARTIAL_FAILED',
      generation: result(),
      manipulation: result(true),
    });
    const first = await repository.findWithModelResults(row.id);
    expect(first?.modelResults).toHaveLength(2);
    expect(first?.status).toBe('QUEUED');
    const generation = first!.modelResults.find(
      (value) => value.kind === 'GENERATION',
    );
    await repository.saveModelResults(row.id, {
      status: 'COMPLETED',
      generation: null,
      manipulation: result(),
    });
    const second = await repository.findWithModelResults(row.id);
    expect(
      second!.modelResults.find((value) => value.kind === 'GENERATION'),
    ).toEqual(generation);
    expect(
      second!.modelResults.find((value) => value.kind === 'MANIPULATION')
        ?.status,
    ).toBe('SUCCEEDED');
    await repository.saveSummary(row.id, { status: 'FAILED' });
    expect((await repository.findWithModelResults(row.id))?.summaryStatus).toBe(
      'FAILED',
    );
  });
  it('rolls back all writes when a model violates a database constraint', async () => {
    const row = await repository.create(
      'test-user',
      'hash',
      new Date(Date.now() + 10000),
    );
    await expect(
      repository.saveModelResults(row.id, {
        status: 'COMPLETED',
        generation: result(),
        manipulation: { ...result(), decision: 'INVALID' as any },
      }),
    ).rejects.toThrow();
    const saved = await repository.findWithModelResults(row.id);
    expect(saved?.modelResults).toHaveLength(0);
    expect(saved?.imageResultStatus).toBeNull();
  });
  it.each([
    [
      'success',
      {
        ...result(),
        decision: 'AI_GENERATED_SUSPECTED' as const,
        displayScore: 80,
      },
    ],
    ['failed', result(true)],
    ['inconclusive', { ...result(), displayScore: null }],
  ])('stores and retrieves %s payload', async (_label, value) => {
    const row = await repository.create(
      'user',
      'hash',
      new Date(Date.now() + 10000),
    );
    await repository.saveModelResults(row.id, {
      status: value.status === 'FAILED' ? 'FAILED' : 'COMPLETED',
      generation: value,
      manipulation: null,
    });
    const saved = await repository.findWithModelResults(row.id);
    expect(saved?.modelResults[0]).toMatchObject({
      status: value.status,
      decision: value.decision,
      displayScore: value.displayScore,
    });
  });
  it.each([
    { decision: 'INCONCLUSIVE', displayScore: null },
    { decision: null, displayScore: 30 },
  ])('DB rejects FAILED with a non-null decision or score', async (invalid) => {
    const row = await repository.create(
      'user',
      'hash',
      new Date(Date.now() + 10000),
    );
    await expect(
      prisma.analysisModelResult.create({
        data: {
          ...result(true),
          ...invalid,
          decision: invalid.decision as any,
          analysisId: row.id,
          kind: 'GENERATION',
        },
      }),
    ).rejects.toThrow();
    expect(
      (await repository.findWithModelResults(row.id))?.modelResults,
    ).toHaveLength(0);
  });
  it.each([
    'BOTH_SUCCESS',
    'GENERATION_FAILED',
    'MANIPULATION_FAILED',
    'BOTH_FAILED',
    'INCONCLUSIVE',
    'TIMEOUT',
  ] as const)('runs real service→Mock→Prisma flow for %s', async (scenario) => {
    const config = new ConfigService({
      NODE_ENV: 'development',
      ANALYSIS_MAX_FILE_BYTES: '128',
      ANALYSIS_RETENTION_SECONDS: '86400',
      AI_REQUEST_TIMEOUT_MS: '30',
    });
    const provider = new MockImageAnalysisProvider(scenario);
    const imageService = new ImageAnalysisService(provider, config);
    const usage = {
      reserveAiUsage: async () => {},
      releaseAiUsage: async () => {},
    } as AnalysisUsageService;
    const service = new AnalysisService(
      repository,
      imageService,
      usage,
      config,
    );
    const buffer = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    const file = {
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
      originalname: 'test.png',
    } as Express.Multer.File;
    const userId = randomUUID();
    if (scenario === 'BOTH_FAILED' || scenario === 'TIMEOUT') {
      await expect(service.create(userId, file)).rejects.toMatchObject({
        status: 503,
      });
    } else {
      const response = await service.create(userId, file);
      expect(response.result.status).toBe('COMPLETED');
      expect(response.result.aiRiskLevel).toBeNull();
    }
    const saved = await prisma.analysis.findFirstOrThrow({
      where: { userId },
      include: { modelResults: true },
    });
    expect(saved.status).toBe(
      scenario === 'BOTH_FAILED' || scenario === 'TIMEOUT'
        ? 'FAILED'
        : 'COMPLETED',
    );
    expect(saved.modelResults).toHaveLength(scenario === 'TIMEOUT' ? 0 : 2);
    if (scenario === 'GENERATION_FAILED' || scenario === 'MANIPULATION_FAILED')
      expect(saved.imageResultStatus).toBe('PARTIAL_FAILED');
    if (scenario === 'INCONCLUSIVE')
      expect(
        saved.modelResults.find((m) => m.kind === 'GENERATION'),
      ).toMatchObject({ decision: 'INCONCLUSIVE', displayScore: null });
    for (const model of saved.modelResults) {
      expect(model).not.toHaveProperty('rawScore');
      expect(model).not.toHaveProperty('localization');
    }
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
  it('rolls back final metadata and model writes together when v1 completion fails', async () => {
    const row = await repository.create(
      'test-user',
      'hash',
      new Date(Date.now() + 10000),
    );
    await repository.analyzing(row.id);
    await expect(
      repository.completeV1(
        row.id,
        {
          status: 'COMPLETED',
          generation: result(),
          manipulation: { ...result(), decision: 'INVALID' as any },
        },
        new Date(),
      ),
    ).rejects.toThrow();
    const saved = await repository.findWithModelResults(row.id);
    expect(saved?.status).toBe('ANALYZING');
    expect(saved?.completedAt).toBeNull();
    expect(saved?.imageResultStatus).toBeNull();
    expect(saved?.modelResults).toHaveLength(0);
  });
  it('v0.2 retry preserves successful CuRe, stores only allowed fields and reconstructs overall result', async () => {
    const config = new ConfigService({ AI_REQUEST_TIMEOUT_MS: '1000' });
    const row = await repository.create(
      'retry-user',
      'hash',
      new Date(Date.now() + 10000),
    );
    const elementId = randomUUID();
    const file = { buffer: Buffer.from('fixture') } as Express.Multer.File;
    const makeRequest = (models: 'ALL' | 'MANIPULATION') => ({
      file,
      analysisId: row.id,
      elementId,
      requestId: randomUUID(),
      models,
      sourceType: 'IMAGE' as const,
      deadlineAt: new Date(Date.now() + 1000).toISOString(),
    });
    const first = await new ImageAnalysisService(
      new MockImageAnalysisProvider('MANIPULATION_FAILED'),
      config,
    ).analyze(file, makeRequest('ALL'));
    if (!('format' in first)) throw new Error('Expected v0.2');
    await repository.completeV1(row.id, first.models, first.completedAt);
    const previous = await repository.findWithModelResults(row.id);
    const originalGeneration = previous!.modelResults.find(
      (m) => m.kind === 'GENERATION',
    );
    const second = await new ImageAnalysisService(
      new MockImageAnalysisProvider('LOCALIZATION'),
      config,
    ).analyze(file, makeRequest('MANIPULATION'));
    if (!('format' in second)) throw new Error('Expected v0.2');
    expect(second.models.generation).toBeNull();
    await repository.completeV1(row.id, second.models, second.completedAt);
    const saved = await repository.findWithModelResults(row.id);
    expect(saved!.modelResults).toHaveLength(2);
    const generation = saved!.modelResults.find(
      (m) => m.kind === 'GENERATION',
    )!;
    const manipulation = saved!.modelResults.find(
      (m) => m.kind === 'MANIPULATION',
    )!;
    expect(generation).toEqual(originalGeneration);
    expect(saved?.aiGenerationScore).toBe(previous?.aiGenerationScore);
    expect(manipulation.status).toBe('SUCCEEDED');
    expect(manipulation).not.toHaveProperty('localization');
    expect(manipulation).not.toHaveProperty('rawScore');
    expect(calculateOverallResult(generation, manipulation)).toMatchObject({
      decision: 'GENERATION_OR_MANIPULATION_SUSPECTED',
      suspectedKinds: ['generation', 'manipulation'],
      uncertainKinds: [],
    });
  });
  it.each([
    ['BOTH_SUCCESS', 202, 'SUSPECTED'],
    ['GENERATION_SUSPECTED', 202, 'SUSPECTED'],
    ['MANIPULATION_SUSPECTED', 202, 'SUSPECTED'],
    ['NO_CLEAR_SIGNAL', 202, 'NO_CLEAR_SIGNAL'],
    ['GENERATION_FAILED', 202, 'SUSPECTED'],
    ['MANIPULATION_FAILED', 202, 'SUSPECTED'],
    ['BOTH_FAILED', 503, 'INCONCLUSIVE'],
    ['INCONCLUSIVE', 202, 'SUSPECTED'],
    ['BOTH_INCONCLUSIVE', 202, 'INCONCLUSIVE'],
    ['TIMEOUT', 503, 'INCONCLUSIVE'],
  ] as const)(
    'verifies POST→Mock→real DB→repository lookup for %s',
    async (selected, status, decision) => {
      scenario = selected;
      provider.analyze.mockClear();
      usage.reserveAiUsage.mockClear();
      usage.releaseAiUsage.mockClear();
      const response = await request(app.getHttpServer())
        .post('/api/analysis')
        .field('type', 'IMAGE')
        .attach(
          'file',
          PNG.sync.write(new PNG({ width: 1, height: 1 })),
          'sample.png',
        )
        .expect(status);
      const context = provider.analyze.mock.calls[0][1];
      const saved = await repository.findWithModelResults(context.analysisId);
      expect(saved).not.toBeNull();
      expect(saved!.status).toBe(status === 503 ? 'FAILED' : 'COMPLETED');
      expect(saved!.completedAt).toBeInstanceOf(Date);
      expect(saved!.errorCode).toBe(status === 503 ? 'ANALYSIS503' : null);
      expect(saved!.modelResults).toHaveLength(selected === 'TIMEOUT' ? 0 : 2);
      for (const model of saved!.modelResults) {
        expect(model.analysisId).toBe(context.analysisId);
        expect(model.modelName).toBe(
          model.kind === 'GENERATION' ? 'CuRe' : 'TruFor',
        );
      }
      if (status === 202)
        expect(response.body.result.analysisId).toBe(context.analysisId);
      const generation =
        saved!.modelResults.find((model) => model.kind === 'GENERATION') ??
        null;
      const manipulation =
        saved!.modelResults.find((model) => model.kind === 'MANIPULATION') ??
        null;
      const overall = calculateOverallResult(generation, manipulation);
      expect(overall.decision).toBe(
        decision === 'SUSPECTED'
          ? 'GENERATION_OR_MANIPULATION_SUSPECTED'
          : decision,
      );
      expect(overall).not.toHaveProperty('score');
      if (selected === 'TIMEOUT') {
        expect(saved!.imageResultStatus).toBeNull();
        expect(provider.analyze.mock.calls[0][2].aborted).toBe(true);
      } else {
        const wire = await provider.analyze.mock.results[0].value;
        expect(saved!.imageResultStatus).toBe(wire.status);
        expect(saved!.completedAt!.toISOString()).toBe(wire.completedAt);
        expect(overall).toEqual(wire.overallResult);
        for (const [key, stored] of [
          ['generation', generation],
          ['manipulation', manipulation],
        ] as const) {
          const model = wire[key]!;
          expect(stored).toMatchObject({
            analysisId: context.analysisId,
            modelName: model.modelName,
            modelVersion: model.modelVersion,
            policyVersion: model.policyVersion,
            status: model.status,
            decision: model.decision,
            displayScore: model.displayScore,
            reasons: model.reasons.map((description: string) => ({
              description,
            })),
            limitations: model.limitations,
            errorCode: model.errorCode,
            retryable: model.error?.retryable ?? null,
          });
          expect(stored).not.toHaveProperty('rawScore');
          expect(stored).not.toHaveProperty('localization');
        }
      }
      if (status === 202) {
        expect(response.body.result).toMatchObject({
          status: saved!.status,
          errorCode: saved!.errorCode,
          completedAt: saved!.completedAt!.toISOString(),
          aiGenerationScore: saved!.aiGenerationScore,
          reasons: saved!.reasons,
          modelVersion: saved!.modelVersion,
        });
      }
      expect(JSON.stringify(response.body)).not.toMatch(
        /rawScore|localization/,
      );
      expect(usage.reserveAiUsage).toHaveBeenCalledTimes(1);
      expect(usage.releaseAiUsage).toHaveBeenCalledTimes(
        status === 503 ? 1 : 0,
      );
    },
  );
  it('upserts repeated model results without duplicates and retrieves the latest stored values', async () => {
    const row = await repository.create(
      'development-user',
      'duplicate-test',
      new Date(Date.now() + 10000),
    );
    const models = {
      status: 'COMPLETED' as const,
      generation: result(),
      manipulation: result(),
    };
    await repository.completeV1(row.id, models, new Date());
    const first = await repository.findWithModelResults(row.id);
    const completedAt = new Date();
    models.manipulation = {
      ...result(),
      decision: 'MANIPULATION_SUSPECTED',
      displayScore: 99,
    };
    await repository.completeV1(row.id, models, completedAt);
    await repository.completeV1(row.id, models, completedAt);
    const saved = await repository.findWithModelResults(row.id);
    expect(saved!.modelResults).toHaveLength(2);
    expect(saved!.modelResults.map((model) => model.id).sort()).toEqual(
      first!.modelResults.map((model) => model.id).sort(),
    );
    expect(
      await prisma.analysisModelResult.count({ where: { analysisId: row.id } }),
    ).toBe(2);
    const generation = saved!.modelResults.find(
      (model) => model.kind === 'GENERATION',
    )!;
    const manipulation = saved!.modelResults.find(
      (model) => model.kind === 'MANIPULATION',
    )!;
    expect(manipulation).toMatchObject(models.manipulation);
    expect(generation).toMatchObject(models.generation);
    expect(saved!.completedAt).toEqual(completedAt);
    expect(calculateOverallResult(generation, manipulation).decision).toBe(
      'GENERATION_OR_MANIPULATION_SUSPECTED',
    );
  });
  it('returns null from repository for a missing analysisId', async () => {
    expect(await repository.findWithModelResults(randomUUID())).toBeNull();
  });
  it('supports History ordering, pagination, recent three and summary detail with existing models', async () => {
    const userId = `history-${randomUUID()}`;
    const createdAt = new Date('2026-10-15T00:00:00Z');
    const expiresAt = new Date(Date.now() + 60000);
    const ids = Array.from({ length: 4 }, () => randomUUID())
      .sort()
      .reverse();
    for (const id of ids) {
      await prisma.analysis.create({
        data: {
          id,
          userId,
          type: 'IMAGE',
          status: 'COMPLETED',
          requestHash: 'history-test',
          createdAt,
          expiresAt,
          summaryStatus: 'COMPLETED',
          summary: '저장된 요약',
          summaryModel: 'test-model',
          summarizedAt: createdAt,
        },
      });
    }
    await prisma.analysis.create({
      data: {
        userId,
        type: 'TEXT',
        status: 'QUEUED',
        requestHash: 'pending',
        createdAt: new Date(createdAt.getTime() + 1000),
        expiresAt,
      },
    });
    await prisma.analysis.create({
      data: {
        userId,
        type: 'IMAGE',
        status: 'COMPLETED',
        requestHash: 'expired',
        createdAt: new Date(createdAt.getTime() + 2000),
        expiresAt: new Date(0),
        summaryStatus: 'COMPLETED',
      },
    });
    await prisma.analysis.create({
      data: {
        userId: `${userId}-other`,
        type: 'IMAGE',
        status: 'COMPLETED',
        requestHash: 'other-user',
        createdAt,
        expiresAt,
        summaryStatus: 'COMPLETED',
      },
    });
    const where = {
      userId,
      expiresAt: { gt: new Date() },
      summaryStatus: 'COMPLETED' as const,
    };
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const first = await prisma.analysis.findMany({ where, orderBy, take: 3 });
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 3));
    const next = await prisma.analysis.findMany({
      where,
      orderBy,
      cursor: { id: first[2].id },
      skip: 1,
      take: 3,
    });
    expect(next.map((row) => row.id)).toEqual(ids.slice(3));
    expect(await prisma.analysis.count({ where })).toBe(4);
    const detail = await repository.findWithModelResults(ids[0]);
    expect(detail).toMatchObject({
      id: ids[0],
      userId,
      summaryStatus: 'COMPLETED',
      summary: '저장된 요약',
      summaryModel: 'test-model',
      summarizedAt: createdAt,
      modelResults: [],
    });
  });
  it('enforces the model FK and unique key and reuses rows on repeated saves', async () => {
    const row = await repository.create(
      'schema-audit',
      'hash',
      new Date(Date.now() + 60000),
    );
    const payload = {
      status: 'COMPLETED' as const,
      generation: result(),
      manipulation: result(),
    };
    await repository.saveModelResults(row.id, payload);
    const before = (await repository.findWithModelResults(row.id))!;
    await repository.saveModelResults(row.id, payload);
    const after = (await repository.findWithModelResults(row.id))!;
    expect(after.modelResults.map((model) => model.id).sort()).toEqual(
      before.modelResults.map((model) => model.id).sort(),
    );
    expect(after.modelResults).toHaveLength(2);
    await expect(
      prisma.analysisModelResult.create({
        data: { ...result(), analysisId: row.id, kind: 'GENERATION' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.analysisModelResult.create({
        data: { ...result(), analysisId: randomUUID(), kind: 'GENERATION' },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
  it('stores summary transitions without changing analysis or model data', async () => {
    const row = await repository.create(
      'schema-audit',
      'hash',
      new Date(Date.now() + 60000),
    );
    await repository.saveModelResults(row.id, {
      status: 'COMPLETED',
      generation: result(),
      manipulation: null,
    });
    const before = (await repository.findWithModelResults(row.id))!;
    const summarizedAt = new Date();
    await repository.saveSummary(row.id, { status: 'PENDING' });
    expect(await repository.findWithModelResults(row.id)).toMatchObject({
      summaryStatus: 'PENDING',
      summary: null,
      summaryModel: null,
      summarizedAt: null,
    });
    await repository.saveSummary(row.id, {
      status: 'COMPLETED',
      summary: '검증용 요약입니다.',
      model: 'test-model',
      summarizedAt,
    });
    expect(await repository.findWithModelResults(row.id)).toMatchObject({
      summaryStatus: 'COMPLETED',
      summary: '검증용 요약입니다.',
      summaryModel: 'test-model',
      summarizedAt,
    });
    await repository.saveSummary(row.id, { status: 'FAILED' });
    const after = (await repository.findWithModelResults(row.id))!;
    expect(after).toMatchObject({
      summaryStatus: 'FAILED',
      summary: null,
      summaryModel: null,
      summarizedAt: null,
    });
    expect(after.modelResults).toEqual(before.modelResults);
    expect(after.status).toBe(before.status);
    expect(after.completedAt).toEqual(before.completedAt);
  });
  it('migration chain matches the Prisma schema', () => {
    const diff = spawnSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'diff',
        '--from-url',
        connection.toString(),
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: connection.toString() },
      },
    );
    // 접속 URL(비밀번호)을 오류 메시지에 노출하지 않는다.
    expect(diff.status).toBe(0);
  });
});
