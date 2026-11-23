import { INestApplication } from '@nestjs/common';
import { Analysis, AnalysisType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { historyTestApp, historyToken } from './fixtures/history-test-app';

const base = '/api/analysis/history';
describe('analysis history authenticated HTTP API', () => {
  let app: INestApplication;
  let rows: Analysis[];
  const provider = { analyze: jest.fn() };
  const db = {
    analysis: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const row = (overrides: Partial<Analysis> = {}): Analysis => ({
    id: randomUUID(),
    userId: 'alice',
    type: 'IMAGE',
    status: 'COMPLETED',
    requestHash: 'private-hash',
    aiGenerationScore: 42,
    aiRiskLevel: 'CAUTION',
    reasons: [{ description: '저장된 근거', rawScore: 'private' }],
    modelVersion: 'stored',
    errorCode: null,
    createdAt: new Date(),
    completedAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    imageResultStatus: null,
    summary: null,
    summaryStatus: null,
    summaryModel: null,
    summarizedAt: null,
    ...overrides,
  });
  function matches(r: Analysis, where: any) {
    return (
      (!where.id || r.id === where.id) &&
      r.userId === where.userId &&
      (!where.expiresAt || r.expiresAt > where.expiresAt.gt)
    );
  }
  const get = (path = base, user = 'alice') =>
    request(app.getHttpServer())
      .get(path)
      .auth(historyToken(user), { type: 'bearer' });
  const del = (path = base, user = 'alice') =>
    request(app.getHttpServer())
      .delete(path)
      .auth(historyToken(user), { type: 'bearer' });
  beforeAll(async () => {
    app = await historyTestApp(db, provider);
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    rows = [];
    jest.resetAllMocks();
    db.analysis.findMany.mockImplementation(async ({ where, skip, take }) =>
      rows
        .filter((r) => matches(r, where))
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.id.localeCompare(a.id),
        )
        .slice(skip, skip + take),
    );
    db.analysis.count.mockImplementation(
      async ({ where }) => rows.filter((r) => matches(r, where)).length,
    );
    db.analysis.findFirst.mockImplementation(
      async ({ where }) => rows.find((r) => matches(r, where)) ?? null,
    );
    db.analysis.deleteMany.mockImplementation(async ({ where }) => {
      const count = rows.filter((r) => matches(r, where)).length;
      rows = rows.filter((r) => !matches(r, where));
      return { count };
    });
    db.$transaction.mockImplementation(async (operations) =>
      Promise.all(operations),
    );
  });
  afterEach(() => {
    expect(provider.analyze).not.toHaveBeenCalled();
  });

  it('returns all currently stored types newest first with stable pagination and no private fields', async () => {
    const types = Object.values(AnalysisType);
    const own = types.map((type, i) =>
      row({ type, createdAt: new Date(Date.now() - i * 1000) }),
    );
    rows.push(
      ...own.reverse(),
      row({ userId: 'bob' }),
      row({ expiresAt: new Date(0) }),
    );
    const response = await get(`${base}?page=1&limit=2`).expect(200);
    expect(response.body).toMatchObject({
      isSuccess: true,
      code: 'ANALYSIS200',
      result: { page: 1, limit: 2, total: types.length, hasNext: true },
    });
    expect(response.body.result.items.map((x: any) => x.type)).toEqual(
      types.slice(0, 2),
    );
    expect(response.body.result.items[0].targetSummary).toBeNull();
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|userId|requestHash|reasons/,
    );
    const next = await get(`${base}?page=2&limit=2`).expect(200);
    expect(next.body.result.items.map((x: any) => x.type)).toEqual(
      types.slice(2),
    );
    expect(next.body.result.hasNext).toBe(false);
    expect(db.analysis.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'alice', expiresAt: { gt: expect.any(Date) } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 2,
        take: 2,
      }),
    );
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Array), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });
  it('uses descending UUID as the tie breaker', async () => {
    const time = new Date();
    const a = row({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: time,
    });
    const b = row({
      id: '00000000-0000-4000-8000-000000000002',
      createdAt: time,
    });
    rows.push(a, b);
    expect((await get(`${base}?limit=1`)).body.result.items[0].analysisId).toBe(
      b.id,
    );
    expect(
      (await get(`${base}?limit=1&page=2`)).body.result.items[0].analysisId,
    ).toBe(a.id);
  });
  it('returns defaults and an empty list, including pages beyond the total', async () => {
    expect((await get().expect(200)).body.result).toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      hasNext: false,
    });
    rows.push(row());
    expect((await get(`${base}?page=2`).expect(200)).body.result).toMatchObject(
      { items: [], total: 1, hasNext: false },
    );
  });
  it.each([
    'page=0',
    'page=-1',
    'page=1.5',
    'page=abc',
    'page=2147483648',
    'page=2147483647&limit=100',
    'limit=0',
    'limit=101',
    'limit=Infinity',
    'limit=1.5',
    'page=1&page=2',
  ])('rejects malformed or overflowing pagination: %s', async (query) => {
    expect((await get(`${base}?${query}`).expect(400)).body.code).toBe(
      'COMMON400',
    );
    expect(db.analysis.findMany).not.toHaveBeenCalled();
  });
  it.each(['get', 'delete'] as const)(
    'requires JWT for every %s endpoint even in development',
    async (method) => {
      for (const path of [base, `${base}/${randomUUID()}`]) {
        for (const token of [undefined, 'invalid', historyToken('alice', 1)]) {
          const req = request(app.getHttpServer())[method](path);
          if (token) req.auth(token, { type: 'bearer' });
          expect((await req.expect(401)).body.code).toBe('AUTH401');
        }
      }
      expect(db.analysis.findFirst).not.toHaveBeenCalled();
      expect(db.analysis.deleteMany).not.toHaveBeenCalled();
      expect(db.analysis.findMany).not.toHaveBeenCalled();
    },
  );
  it('returns only stored common fields in a dedicated history detail response', async () => {
    const stored = row();
    rows.push(stored);
    const response = await get(`${base}/${stored.id}`).expect(200);
    expect(response.body.result).toEqual({
      analysisId: stored.id,
      type: stored.type,
      status: stored.status,
      aiGenerationScore: 42,
      aiRiskLevel: 'CAUTION',
      reasons: [{ description: '저장된 근거' }],
      createdAt: stored.createdAt.toISOString(),
      completedAt: stored.completedAt!.toISOString(),
      detail: null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|rawScore|requestHash|userId/,
    );
  });
  it.each(['QUEUED', 'ANALYZING', 'FAILED'] as const)(
    'returns persisted %s records without inventing results',
    async (status) => {
      const stored = row({
        status,
        aiGenerationScore: null,
        aiRiskLevel: null,
        reasons: null,
        completedAt: null,
      });
      rows.push(stored);
      expect((await get(`${base}/${stored.id}`)).body.result).toMatchObject({
        status,
        aiGenerationScore: null,
        aiRiskLevel: null,
        reasons: null,
        completedAt: null,
        detail: null,
      });
    },
  );
  it.each(['missing', 'other-owner', 'expired'])(
    'hides %s detail with the same 404',
    async (kind) => {
      const stored = row({
        userId: kind === 'other-owner' ? 'bob' : 'alice',
        expiresAt:
          kind === 'expired' ? new Date(0) : new Date(Date.now() + 60000),
      });
      if (kind !== 'missing') rows.push(stored);
      expect(
        (await get(`${base}/${stored.id}`).expect(404)).body,
      ).toMatchObject({ isSuccess: false, code: 'COMMON404', result: null });
    },
  );
  it.each(['get', 'delete'] as const)(
    'validates UUID for %s detail before DB access',
    async (method) => {
      await request(app.getHttpServer())
        [method](`${base}/bad`)
        .auth(historyToken(), { type: 'bearer' })
        .expect(400);
      expect(db.analysis.findFirst).not.toHaveBeenCalled();
      expect(db.analysis.deleteMany).not.toHaveBeenCalled();
    },
  );
  it('atomically deletes an owned record and immediately hides it from detail and list', async () => {
    const own = row();
    const other = row({ userId: 'bob' });
    rows.push(own, other);
    expect(
      (await del(`${base}/${own.id}`).expect(200)).body.result.deletedCount,
    ).toBe(1);
    expect(db.analysis.deleteMany).toHaveBeenCalledWith({
      where: { id: own.id, userId: 'alice' },
    });
    await get(`${base}/${own.id}`).expect(404);
    await del(`${base}/${own.id}`).expect(404);
    expect((await get()).body.result.items).toEqual([]);
    expect(rows.map((r) => r.id)).toEqual([other.id]);
  });
  it('does not delete other users or missing records', async () => {
    const other = row({ userId: 'bob' });
    rows.push(other);
    for (const id of [other.id, randomUUID()])
      expect((await del(`${base}/${id}`).expect(404)).body.code).toBe(
        'COMMON404',
      );
    expect(rows).toEqual([other]);
  });
  it('deletes all owned records including expired ones and succeeds for an empty user', async () => {
    const active = row();
    rows.push(active, row({ expiresAt: new Date(0) }), row({ userId: 'bob' }));
    expect((await del().expect(200)).body.result.deletedCount).toBe(2);
    expect(db.analysis.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'alice' },
    });
    await get(`${base}/${active.id}`).expect(404);
    expect((await get()).body.result.items).toEqual([]);
    expect((await del().expect(200)).body.result.deletedCount).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('bob');
  });
  it('allows an owner to remove an expired record without making it readable', async () => {
    const stored = row({ expiresAt: new Date(0) });
    rows.push(stored);
    await get(`${base}/${stored.id}`).expect(404);
    await del(`${base}/${stored.id}`).expect(200);
  });
  it.each(['list', 'detail', 'deleteOne', 'deleteAll'])(
    'sanitizes database errors for %s',
    async (operation) => {
      const id = randomUUID();
      if (operation === 'list')
        db.$transaction.mockRejectedValueOnce(new Error('private DB trace'));
      else if (operation === 'detail')
        db.analysis.findFirst.mockRejectedValueOnce(
          new Error('private DB trace'),
        );
      else
        db.analysis.deleteMany.mockRejectedValueOnce(
          new Error('private DB trace'),
        );
      const response = await (
        operation === 'list'
          ? get()
          : operation === 'detail'
            ? get(`${base}/${id}`)
            : operation === 'deleteOne'
              ? del(`${base}/${id}`)
              : del()
      ).expect(500);
      expect(response.body).toMatchObject({
        isSuccess: false,
        code: 'COMMON500',
        result: null,
      });
      expect(JSON.stringify(response.body)).not.toContain('private');
    },
  );
  it('documents four distinct routes with JWT, common envelopes and error responses', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    for (const [path, method] of [
      [base, 'get'],
      [base, 'delete'],
      [`${base}/{analysisId}`, 'get'],
      [`${base}/{analysisId}`, 'delete'],
    ] as const) {
      const op = doc.paths[path][method]!;
      expect(op.security).toEqual([{ bearer: [] }]);
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(['200', '401', '500']),
      );
      expect(op.responses['200']).toHaveProperty('content');
    }
    const list = doc.paths[base].get!;
    expect(list.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'page' }),
        expect.objectContaining({ name: 'limit' }),
      ]),
    );
    expect(doc.paths['/api/api/analysis/history']).toBeUndefined();
    expect(doc.paths['/api/analysis'].post).toBeDefined();
  });
});
