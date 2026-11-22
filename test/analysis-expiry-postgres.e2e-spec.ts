import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisType, PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  AnalysisExpiryRepository,
  ANALYSIS_EXPIRY_BATCH_SIZE,
} from '../src/domains/analysis/analysis-expiry.repository';
import { AnalysisExpiryCleanupService } from '../src/domains/analysis/analysis-expiry-cleanup.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { historyTestApp, historyToken } from './fixtures/history-test-app';

const dbDescribe = process.env.HISTORY_DB_URL ? describe : describe.skip;
dbDescribe('physical expiry cleanup in an isolated PostgreSQL schema', () => {
  const schema = `expiry_test_${randomUUID().replaceAll('-', '')}`;
  let connection: URL;
  let prisma: PrismaClient;
  let app: INestApplication;
  let repository: AnalysisExpiryRepository;
  const ai = { analyze: jest.fn() };
  function sql(input: string) {
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
        input,
        env: {
          ...process.env,
          PGPASSWORD: decodeURIComponent(connection.password),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  }
  const create = (expiresAt: Date, extra: object = {}) =>
    prisma.analysis.create({
      data: {
        userId: 'expiry-owner',
        type: 'IMAGE',
        status: 'COMPLETED',
        requestHash: 'synthetic-expiry-test',
        expiresAt,
        summary: '저장된 테스트 요약',
        summaryStatus: 'COMPLETED',
        summaryModel: 'synthetic-model',
        summarizedAt: new Date(),
        ...extra,
      },
    });
  const model = {
    kind: 'GENERATION',
    status: 'SUCCEEDED',
    decision: 'AI_GENERATED_SUSPECTED',
    displayScore: 75,
    reasons: [],
    limitations: [],
    modelName: 'stored',
    modelVersion: 'v1',
    policyVersion: 'v1',
  };
  beforeAll(async () => {
    connection = new URL(process.env.HISTORY_DB_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(connection.hostname) ||
      !/^history_test_\d+$/.test(connection.pathname.slice(1))
    )
      throw Error('Explicit isolated expiry test DB required');
    const migrations = readdirSync('prisma/migrations')
      .filter((name) => /^\d/.test(name))
      .sort()
      .map((name) =>
        readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'),
      )
      .join('\n')
      .replaceAll('"public"', `"${schema}"`);
    sql(
      `BEGIN; CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; ${migrations} COMMIT;`,
    );
    const url = new URL(connection);
    url.searchParams.set('schema', schema);
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    await prisma.$connect();
    repository = new AnalysisExpiryRepository(
      prisma as unknown as PrismaService,
    );
    app = await historyTestApp(prisma, ai);
  });
  beforeEach(async () => {
    await prisma.analysis.deleteMany();
    ai.analyze.mockClear();
  });
  afterEach(() => expect(ai.analyze).not.toHaveBeenCalled());
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    if (connection) sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });

  it('deletes expired and exactly-at-cutoff rows across users/types, but never later rows', async () => {
    const cutoff = new Date();
    const expired = [];
    for (const [i, type] of Object.values(AnalysisType).entries())
      expired.push(
        await create(new Date(cutoff.getTime() - i), {
          type,
          userId: `expiry-user-${i}`,
        }),
      );
    const active = await create(new Date(cutoff.getTime() + 1));
    const laterOther = await create(new Date(cutoff.getTime() + 86400000), {
      userId: 'other-owner',
    });
    expect(await repository.deleteExpiredBatch(cutoff)).toBe(expired.length);
    expect(
      await prisma.analysis.count({
        where: { id: { in: expired.map((r) => r.id) } },
      }),
    ).toBe(0);
    expect((await prisma.analysis.findMany()).map((r) => r.id).sort()).toEqual(
      [active.id, laterOther.id].sort(),
    );
    expect(await repository.deleteExpiredBatch(cutoff)).toBe(0);
  });
  it.each(['UTC', 'Asia/Seoul'])(
    'compares UTC stored timestamps correctly under session timezone %s',
    async (zone) => {
      const cutoff = new Date();
      const expired = await create(cutoff);
      const active = await create(new Date(cutoff.getTime() + 1));
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('TimeZone', ${zone}, true)`;
        const scoped = new AnalysisExpiryRepository(
          tx as unknown as PrismaService,
        );
        expect(await scoped.deleteExpiredBatch(cutoff)).toBe(1);
      });
      expect(
        await prisma.analysis.findUnique({ where: { id: expired.id } }),
      ).toBeNull();
      expect(
        await prisma.analysis.findUnique({ where: { id: active.id } }),
      ).not.toBeNull();
    },
  );
  it('physically removes expired parent/model data, preserves live rows, and never triggers AI on history reads', async () => {
    const expired = await create(new Date(Date.now() - 1000), {
      modelResults: { create: model },
    });
    const live = await create(new Date(Date.now() + 60000), {
      userId: 'other-owner',
      modelResults: { create: model },
    });
    expect(
      await prisma.analysis.findUnique({ where: { id: expired.id } }),
    ).not.toBeNull();
    await request(app.getHttpServer())
      .get(`/api/analysis/history/${expired.id}`)
      .auth(historyToken('expiry-owner'), { type: 'bearer' })
      .expect(404);
    const cleanup = new AnalysisExpiryCleanupService(
      repository,
      new ConfigService(),
    );
    await cleanup.runOnce();
    await cleanup.onModuleDestroy();
    expect(
      await prisma.analysis.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    expect(
      await prisma.analysisModelResult.count({
        where: { analysisId: expired.id },
      }),
    ).toBe(0);
    expect(
      await prisma.analysis.findUnique({ where: { id: live.id } }),
    ).not.toBeNull();
    expect(
      await prisma.analysisModelResult.count({
        where: { analysisId: live.id },
      }),
    ).toBe(1);
    await request(app.getHttpServer())
      .get(`/api/analysis/history/${expired.id}`)
      .auth(historyToken('expiry-owner'), { type: 'bearer' })
      .expect(404);
    const response = await request(app.getHttpServer())
      .get('/api/analysis/history')
      .auth(historyToken('expiry-owner'), { type: 'bearer' })
      .expect(200);
    expect(response.body.result.items).toEqual([]);
  });
  it('limits each atomic batch and removes the remaining backlog on later runs', async () => {
    const now = new Date();
    await prisma.analysis.createMany({
      data: Array.from({ length: ANALYSIS_EXPIRY_BATCH_SIZE + 1 }, () => ({
        id: randomUUID(),
        userId: 'expiry-owner',
        type: 'IMAGE',
        requestHash: 'batch',
        expiresAt: new Date(now.getTime() - 1000),
      })),
    });
    const live = await create(new Date(now.getTime() + 86400000));
    expect(await repository.deleteExpiredBatch(now)).toBe(
      ANALYSIS_EXPIRY_BATCH_SIZE,
    );
    expect(await repository.deleteExpiredBatch(now)).toBe(1);
    expect(await repository.deleteExpiredBatch(now)).toBe(0);
    expect(await prisma.analysis.count()).toBe(1);
    expect(
      await prisma.analysis.findUnique({ where: { id: live.id } }),
    ).not.toBeNull();
  });
  it('skips a locked row whose expiry is being extended and cleans other expired rows', async () => {
    const now = new Date();
    const extended = await create(new Date(now.getTime() - 1000));
    const expired = await create(new Date(now.getTime() - 2000));
    await prisma.$transaction(async (tx) => {
      await tx.analysis.update({
        where: { id: extended.id },
        data: { expiresAt: new Date(now.getTime() + 86400000) },
      });
      expect(await repository.deleteExpiredBatch(now)).toBe(1);
    });
    expect(
      await prisma.analysis.findUnique({ where: { id: extended.id } }),
    ).not.toBeNull();
    expect(
      await prisma.analysis.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    expect(await repository.deleteExpiredBatch(now)).toBe(0);
  });
  it('allows independent instances to clean concurrently without touching live data', async () => {
    const now = new Date();
    await prisma.analysis.createMany({
      data: Array.from({ length: 20 }, () => ({
        id: randomUUID(),
        userId: 'expiry-owner',
        type: 'IMAGE',
        requestHash: 'concurrent',
        expiresAt: new Date(now.getTime() - 1000),
      })),
    });
    const live = await create(new Date(now.getTime() + 86400000));
    const second = new AnalysisExpiryRepository(
      prisma as unknown as PrismaService,
    );
    const counts = await Promise.all([
      repository.deleteExpiredBatch(now),
      second.deleteExpiredBatch(now),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(20);
    expect(await prisma.analysis.count()).toBe(1);
    expect(
      await prisma.analysis.findUnique({ where: { id: live.id } }),
    ).not.toBeNull();
  });
});
