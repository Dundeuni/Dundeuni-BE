import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { PrismaClient } from '@prisma/client';
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
