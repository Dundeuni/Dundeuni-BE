import { AnalysisSummaryRepository } from '../src/domains/analysis/analysis-summary.repository';
import { AnalysisSummaryWorker } from '../src/domains/analysis/analysis-summary.worker';
import {
  GeminiSummaryClient,
  SummaryError,
  summaryInput,
} from '../src/domains/analysis/gemini-summary.client';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PNG } from 'pngjs';
import { AppModule } from '../src/app.module';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
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
    connection = new URL(parse(readFileSync('.env')).DATABASE_URL);
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
          ANALYSIS_MAX_FILE_BYTES: '1024',
          ANALYSIS_RETENTION_SECONDS: '86400',
          AI_REQUEST_TIMEOUT_MS: '1000',
          GEMINI_SUMMARY_ENABLED: 'true',
        }),
      )
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AnalysisUsageService)
      .useValue({
        reserveAiUsage: async () => {},
        releaseAiUsage: async () => {},
      })
      .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
      .useValue(new MockImageAnalysisProvider('BOTH_SUCCESS'))
      .overrideProvider(AnalysisSummaryWorker)
      .useValue({})
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
  const summaryConfig = new ConfigService({
    GEMINI_SUMMARY_ENABLED: 'true',
    GEMINI_SUMMARY_RETRY_MS: '1',
    GEMINI_SUMMARY_MAX_ATTEMPTS: '2',
  });
  const jobs = () =>
    new AnalysisSummaryRepository(
      prisma as unknown as PrismaService,
      summaryConfig,
    );
  async function summaryReady() {
    const row = await repository.create(
      'test-user',
      'test-hash',
      new Date(Date.now() + 60000),
    );
    await repository.completeV1(
      row.id,
      {
        status: 'PARTIAL_FAILED',
        generation: result(),
        manipulation: result(true),
      },
      new Date(),
    );
    await jobs().enqueue(row.id);
    return row.id;
  }
  it('durably registers once, atomically claims, fences stale workers and preserves model results', async () => {
    const id = await summaryReady();
    const jobRepo = jobs();
    await jobRepo.enqueue(id);
    expect(
      await prisma.analysisSummaryJob.count({ where: { analysisId: id } }),
    ).toBe(1);
    expect((await jobRepo.get(id, 'test-user')).result.summaryStatus).toBe(
      'PENDING',
    );
    const claims = await Promise.all([jobRepo.claim(), jobRepo.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find(Boolean)!;
    await prisma.analysisSummaryJob.update({
      where: { analysisId: id },
      data: { leaseUntil: new Date(0) },
    });
    const recovered = await jobs().claim(); // New instance after a simulated process crash.
    expect(recovered?.attempts).toBe(2);
    expect(
      await jobRepo.finish(first, { summary: 'stale', model: 'test' }),
    ).toBe(false);
    const before = (await repository.findWithModelResults(id))!;
    await jobRepo.finish(recovered!, {
      summary: 'checked summary',
      model: 'mock-gemini',
    });
    expect((await jobRepo.get(id, 'test-user')).result).toMatchObject({
      summaryStatus: 'COMPLETED',
      summary: 'checked summary',
    });
    expect(
      await jobRepo.finish(recovered!, { summary: 'overwrite', model: 'bad' }),
    ).toBe(false);
    expect((await repository.findWithModelResults(id))!.modelResults).toEqual(
      before.modelResults,
    );
    await expect(jobRepo.get(id, 'other-user')).rejects.toMatchObject({
      status: 404,
    });
  });
  it('retries transient failures then completes through worker, permanent failure preserves image data', async () => {
    const id = await summaryReady();
    const jobRepo = jobs();
    const client = {
      generate: jest
        .fn()
        .mockRejectedValueOnce(new SummaryError('GEMINI_UNAVAILABLE', true))
        .mockResolvedValueOnce({
          summary: 'valid tested summary',
          model: 'mock',
        }),
    };
    const worker = new AnalysisSummaryWorker(
      jobRepo,
      client as unknown as GeminiSummaryClient,
      summaryConfig,
    );
    await worker.processOne();
    expect((await jobRepo.get(id, 'test-user')).result.summaryStatus).toBe(
      'PENDING',
    );
    await prisma.analysisSummaryJob.update({
      where: { analysisId: id },
      data: { nextRunAt: new Date(0) },
    });
    await worker.processOne();
    expect((await jobRepo.get(id, 'test-user')).result.summaryStatus).toBe(
      'COMPLETED',
    );
    const failed = await summaryReady();
    const before = await repository.findWithModelResults(failed);
    client.generate.mockRejectedValue(new SummaryError('GEMINI_AUTH'));
    await worker.processOne();
    expect((await jobRepo.get(failed, 'test-user')).result).toMatchObject({
      summaryStatus: 'FAILED',
      summary: null,
    });
    const after = await repository.findWithModelResults(failed);
    expect(after!.modelResults).toEqual(before!.modelResults);
    expect(after!.status).toBe(before!.status);
  });
  it('caps retries and recovers registration gaps without enqueueing unfinished analyses', async () => {
    const id = await summaryReady();
    const jobRepo = jobs();
    for (let i = 0; i < 2; i++) {
      await prisma.analysisSummaryJob.update({
        where: { analysisId: id },
        data: { nextRunAt: new Date(0) },
      });
      await jobRepo.finish(
        (await jobRepo.claim())!,
        new SummaryError('GEMINI_TIMEOUT', true),
      );
    }
    expect((await jobRepo.get(id, 'test-user')).result.summaryStatus).toBe(
      'FAILED',
    );
    const pending = await repository.create(
      'test-user',
      'hash',
      new Date(Date.now() + 60000),
    );
    await jobRepo.enqueue(pending.id);
    expect(
      await prisma.analysisSummaryJob.findUnique({
        where: { analysisId: pending.id },
      }),
    ).toBeNull();
    await repository.completeV1(
      pending.id,
      {
        status: 'FAILED',
        generation: result(true),
        manipulation: result(true),
      },
      new Date(),
    );
    await jobRepo.reconcile();
    expect(
      (await jobRepo.get(pending.id, 'test-user')).result.summaryStatus,
    ).toBe('PENDING');
    const claim = await jobRepo.claim();
    await jobRepo.finish(claim!, new SummaryError('GEMINI_AUTH'));
    expect((await repository.findWithModelResults(pending.id))!.status).toBe(
      'FAILED',
    );
  });
  it.each([[[503, 503]], [[504]], [[503, 503, 503]]])(
    'runs transient sequence %j with Mock Gemini and preserves results',
    async (statuses) => {
      const id = await summaryReady();
      const config = new ConfigService({
        GEMINI_SUMMARY_ENABLED: 'true',
        GEMINI_SUMMARY_MAX_ATTEMPTS: '3',
        GEMINI_SUMMARY_RETRY_MS: '100',
        GEMINI_SUMMARY_RETRY_MAX_MS: '1000',
      });
      const repo = new AnalysisSummaryRepository(
        prisma as unknown as PrismaService,
        config,
      );
      const client = new GeminiSummaryClient(
        new ConfigService({
          GEMINI_API_KEY: 'mock',
          GEMINI_MODEL: 'gemini-test',
        }),
      );
      const inputData = await repo.models(id);
      const input = summaryInput(inputData!.modelResults);
      const answer = JSON.stringify({
        summary:
          'AI 생성 여부는 판단하기 어렵습니다. 이미지 변조 분석은 실패하여 판단할 수 없습니다.',
        generationDecision: input.generation?.decision ?? null,
        manipulationDecision: input.manipulation?.decision ?? null,
        overallDecision: input.overallResult.decision,
      });
      const request = jest.spyOn(client, 'request');
      for (const status of statuses) request.mockRejectedValueOnce({ status });
      request.mockResolvedValue(answer);
      const worker = new AnalysisSummaryWorker(repo, client, config);
      const savedModels = (await repository.findWithModelResults(id))!
        .modelResults;
      for (
        let attempt = 0;
        attempt < Math.min(statuses.length + 1, 3);
        attempt++
      ) {
        await prisma.analysisSummaryJob.update({
          where: { analysisId: id },
          data: { nextRunAt: new Date(0) },
        });
        await worker.processOne();
        const job = await prisma.analysisSummaryJob.findUniqueOrThrow({
          where: { analysisId: id },
        });
        if (job.status === 'PENDING') {
          expect(job.nextRunAt.getTime()).toBeGreaterThan(Date.now());
          expect(await repo.claim()).toBeNull(); // no duplicate or early retry
        }
      }
      const state = statuses.length === 3 ? 'FAILED' : 'COMPLETED';
      expect((await repo.get(id, 'test-user')).result.summaryStatus).toBe(
        state,
      );
      expect((await repository.findWithModelResults(id))!.modelResults).toEqual(
        savedModels,
      );
      request.mockRestore();
    },
  );
  it('safely recovers only failed jobs, rejects duplicate recovery and completed overwrite', async () => {
    const id = await summaryReady();
    const repo = jobs();
    const old = (await repo.claim())!;
    await repo.finish(old, new SummaryError('GEMINI_AUTH'));
    const attempts = await Promise.allSettled([
      repo.recoverFailed(id),
      repo.recoverFailed(id),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const recovered = await repo.claim();
    expect(recovered!.attempts).toBe(1);
    expect(await repo.finish(old, { summary: 'stale', model: 'old' })).toBe(
      false,
    );
    await repo.finish(recovered!, { summary: 'new', model: 'test' });
    await expect(repo.recoverFailed(id)).rejects.toMatchObject({
      code: 'SUMMARY_RECOVERY_NOT_FAILED',
    });
    const expired = await summaryReady();
    await repo.finish((await repo.claim())!, new SummaryError('GEMINI_AUTH'));
    await prisma.analysis.update({
      where: { id: expired },
      data: { expiresAt: new Date(0) },
    });
    await expect(repo.recoverFailed(expired)).rejects.toMatchObject({
      code: 'SUMMARY_RECOVERY_NOT_ELIGIBLE',
    });
    expect(
      (
        await prisma.analysisSummaryJob.findUniqueOrThrow({
          where: { analysisId: expired },
        })
      ).status,
    ).toBe('FAILED');
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
  it.each(['COMPLETED', 'FAILED', 'TIMEOUT'] as const)(
    'runs POST→stored analysis GET→asynchronous Gemini %s without changing image results',
    async (outcome) => {
      const created = await request(app.getHttpServer())
        .post('/api/analysis')
        .field('type', 'IMAGE')
        .attach(
          'file',
          PNG.sync.write(new PNG({ width: 1, height: 1 })),
          'sample.png',
        )
        .expect(202);
      const id = created.body.result.analysisId;
      const before = (await repository.findWithModelResults(id))!;
      expect(before.summaryStatus).toBe('PENDING');
      expect(
        await prisma.analysisSummaryJob.count({ where: { analysisId: id } }),
      ).toBe(1);
      const detail = await request(app.getHttpServer())
        .get(`/api/analysis/${id}`)
        .expect(200);
      expect(detail.body.result).toMatchObject(created.body.result);
      expect(detail.body.result.models.generation).toMatchObject({
        modelName: 'CuRe',
        displayScore: 80,
      });
      expect(detail.body.result.models.manipulation).toMatchObject({
        modelName: 'TruFor',
        displayScore: 80,
      });
      expect(detail.body.result.overallResult.decision).toBe(
        'GENERATION_OR_MANIPULATION_SUSPECTED',
      );
      const pending = await request(app.getHttpServer())
        .get(`/api/analysis/${id}/summary`)
        .expect(200);
      expect(pending.body.result).toMatchObject({
        summaryStatus: 'PENDING',
        summary: null,
      });
      const config = new ConfigService({
        GEMINI_API_KEY: 'test-only',
        GEMINI_MODEL: 'gemini-test',
        GEMINI_TIMEOUT_MS: '5',
        GEMINI_SUMMARY_MAX_ATTEMPTS: '1',
      });
      const client = new GeminiSummaryClient(config);
      const text =
        'AI 생성과 관련된 의심 신호가 감지되었습니다. 이미지 변조와 관련된 의심 신호가 감지되었습니다. 출처와 원본을 확인하는 것이 좋습니다.';
      const input = summaryInput(before.modelResults);
      const adapter = jest.spyOn(client, 'request');
      if (outcome === 'COMPLETED')
        adapter.mockResolvedValue(
          JSON.stringify({
            summary: text,
            generationDecision: input.generation!.decision,
            manipulationDecision: input.manipulation!.decision,
            overallDecision: input.overallResult.decision,
          }),
        );
      else if (outcome === 'TIMEOUT')
        adapter.mockImplementation(() => new Promise(() => {}));
      else adapter.mockRejectedValue({ status: 503 });
      const worker = new AnalysisSummaryWorker(
        new AnalysisSummaryRepository(
          prisma as unknown as PrismaService,
          config,
        ),
        client,
        config,
      );
      // Process only the already-durable job: no real network or background polling in tests.
      await worker.processOne();
      const after = (await repository.findWithModelResults(id))!;
      expect(after.summaryStatus).toBe(
        outcome === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
      );
      expect(after.summary).toBe(outcome === 'COMPLETED' ? text : null);
      expect(after.summaryModel).toBe(
        outcome === 'COMPLETED' ? 'gemini-test' : null,
      );
      expect(after.summarizedAt instanceof Date).toBe(outcome === 'COMPLETED');
      expect(after.modelResults).toEqual(before.modelResults);
      expect(after.status).toBe(before.status);
      expect(after.errorCode).toBe(before.errorCode);
      expect(after.completedAt).toEqual(before.completedAt);
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/analysis/${id}`)
            .expect(200)
        ).body,
      ).toEqual(detail.body);
      const summary = await request(app.getHttpServer())
        .get(`/api/analysis/${id}/summary`)
        .expect(200);
      expect(summary.body.result.summaryStatus).toBe(after.summaryStatus);
      expect(summary.body.result.summary).toBe(after.summary);
      const payload = adapter.mock.calls[0][2];
      expect(Object.keys(payload.generation!).sort()).toEqual([
        'decision',
        'displayScore',
        'status',
      ]);
      expect(JSON.stringify(payload)).not.toMatch(
        /analysisId|rawScore|localization|test-only|reasons|limitations/,
      );
      await worker.onModuleDestroy();
    },
  );
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
