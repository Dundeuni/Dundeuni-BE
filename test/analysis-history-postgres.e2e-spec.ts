import { INestApplication } from '@nestjs/common';
import { AnalysisType, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { historyTestApp, historyToken } from './fixtures/history-test-app';

const dbDescribe = process.env.HISTORY_DB_URL ? describe : describe.skip;
dbDescribe('history HTTP→Prisma→isolated PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let owner: string, other: string;
  const provider = { analyze: jest.fn() };
  const path = '/api/analysis/history';
  const get = (url = path) =>
    request(app.getHttpServer())
      .get(url)
      .auth(historyToken(owner), { type: 'bearer' });
  const del = (url = path) =>
    request(app.getHttpServer())
      .delete(url)
      .auth(historyToken(owner), { type: 'bearer' });
  const create = (userId = owner, extra: object = {}) =>
    prisma.analysis.create({
      data: {
        userId,
        type: 'IMAGE',
        status: 'COMPLETED',
        requestHash: 'synthetic-test-only',
        expiresAt: new Date(Date.now() + 60000),
        aiGenerationScore: 75,
        aiRiskLevel: 'CAUTION',
        reasons: [{ description: '저장된 합성 근거', internal: 'private' }],
        completedAt: new Date(),
        ...extra,
      },
    });
  const createWithModel = (userId = owner) =>
    create(userId, {
      modelResults: {
        create: {
          kind: 'GENERATION',
          status: 'SUCCEEDED',
          decision: 'AI_GENERATED_SUSPECTED',
          displayScore: 75,
          reasons: [],
          limitations: [],
          modelName: 'stored-model',
          modelVersion: 'v1',
          policyVersion: 'v1',
        },
      },
    });
  beforeAll(async () => {
    const url = new URL(process.env.HISTORY_DB_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^history_test_\d+$/.test(url.pathname.slice(1))
    )
      throw new Error('Explicit isolated history test DB required');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    await prisma.$connect();
    app = await historyTestApp(prisma, provider);
  });
  beforeEach(() => {
    owner = `history-${randomUUID()}`;
    other = `history-${randomUUID()}`;
    provider.analyze.mockClear();
  });
  afterEach(async () => {
    expect(provider.analyze).not.toHaveBeenCalled();
    await prisma.analysis.deleteMany({
      where: { userId: { in: [owner, other] } },
    });
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('lists all stored types with pagination, retention, and deterministic sorting', async () => {
    const types = Object.values(AnalysisType);
    const ids: string[] = [];
    for (const [i, type] of types.entries()) {
      ids.push(
        (
          await create(owner, {
            type,
            createdAt: new Date(Date.now() - i * 1000),
          })
        ).id,
      );
    }
    await create(other);
    await create(owner, { expiresAt: new Date(0) });
    const first = await get(`${path}?limit=2`).expect(200);
    expect(first.body.result).toMatchObject({
      page: 1,
      limit: 2,
      total: types.length,
      hasNext: true,
    });
    expect(first.body.result.items.map((r: any) => r.analysisId)).toEqual(
      ids.slice(0, 2),
    );
    const second = await get(`${path}?page=2&limit=2`).expect(200);
    expect(second.body.result.items.map((r: any) => r.analysisId)).toEqual(
      ids.slice(2),
    );
    expect(second.body.result.hasNext).toBe(false);
  });
  it('returns a stable boundary when createdAt ties', async () => {
    const time = new Date();
    const a = await create(owner, { createdAt: time });
    const b = await create(owner, { createdAt: time });
    const expected = [a.id, b.id].sort().reverse();
    const first = await get(`${path}?limit=1`);
    const second = await get(`${path}?limit=1&page=2`);
    expect([
      first.body.result.items[0].analysisId,
      second.body.result.items[0].analysisId,
    ]).toEqual(expected);
  });
  it('reads stored common fields and blocks missing, other-user and expired results', async () => {
    const own = await create();
    const foreign = await create(other);
    const expired = await create(owner, { expiresAt: new Date(0) });
    const response = await get(`${path}/${own.id}`).expect(200);
    expect(response.body.result).toMatchObject({
      analysisId: own.id,
      aiGenerationScore: 75,
      reasons: [{ description: '저장된 합성 근거' }],
      detail: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|internal|requestHash|userId/,
    );
    for (const id of [foreign.id, expired.id, randomUUID()])
      await get(`${path}/${id}`).expect(404);
    await request(app.getHttpServer()).get(`${path}/${own.id}`).expect(401);
  });
  it('deletes one owned row with cascade, prevents repeated/concurrent deletion and preserves another user', async () => {
    const own = await createWithModel();
    const foreign = await createWithModel(other);
    const responses = await Promise.all([
      del(`${path}/${own.id}`),
      del(`${path}/${own.id}`),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(
      await prisma.analysisModelResult.count({ where: { analysisId: own.id } }),
    ).toBe(0);
    expect(
      await prisma.analysisModelResult.count({
        where: { analysisId: foreign.id },
      }),
    ).toBe(1);
    await del(`${path}/${foreign.id}`).expect(404);
    await get(`${path}/${own.id}`).expect(404);
    expect((await get().expect(200)).body.result.items).toEqual([]);
  });
  it('deletes all user rows and model results including expired ones, never affecting another user', async () => {
    const own = await createWithModel();
    const expired = await create(owner, { expiresAt: new Date(0) });
    const foreign = await createWithModel(other);
    expect((await del().expect(200)).body.result.deletedCount).toBe(2);
    expect(await prisma.analysis.count({ where: { userId: owner } })).toBe(0);
    expect(
      await prisma.analysisModelResult.count({ where: { analysisId: own.id } }),
    ).toBe(0);
    expect(
      await prisma.analysis.findUnique({ where: { id: foreign.id } }),
    ).not.toBeNull();
    expect(
      await prisma.analysisModelResult.count({
        where: { analysisId: foreign.id },
      }),
    ).toBe(1);
    for (const id of [own.id, expired.id])
      await get(`${path}/${id}`).expect(404);
    expect((await get().expect(200)).body.result).toMatchObject({
      items: [],
      total: 0,
      hasNext: false,
    });
    expect((await del().expect(200)).body.result.deletedCount).toBe(0);
  });
});
