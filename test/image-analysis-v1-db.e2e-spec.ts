import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  });
  afterAll(async () => {
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
    const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
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
