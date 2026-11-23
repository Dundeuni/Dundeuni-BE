import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { historyTestApp, historyToken } from './fixtures/history-test-app';

const dbDescribe = process.env.HISTORY_DB_URL ? describe : describe.skip;
dbDescribe('PHONE create/history HTTP→Prisma→isolated PostgreSQL', () => {
  let app: INestApplication, prisma: PrismaClient, owner: string, other: string;
  const post = jest.fn(),
    image = { analyze: jest.fn() };
  let previousKey: string | undefined;
  const path = '/api/analysis/history';
  const get = (url = path, user = owner) =>
    request(app.getHttpServer())
      .get(url)
      .auth(historyToken(user), { type: 'bearer' });
  const del = (url = path, user = owner) =>
    request(app.getHttpServer())
      .delete(url)
      .auth(historyToken(user), { type: 'bearer' });
  const create = (phoneNumber = '01012345678', user = owner) =>
    request(app.getHttpServer())
      .post('/api/analyses/phone')
      .auth(historyToken(user), { type: 'bearer' })
      .send({ phoneNumber });
  const wire = (extra: object = {}) => ({
    status: 200,
    data: {
      api: { success: true },
      data: {
        success: 1,
        spam: '보이스피싱',
        spam_count: '1000+',
        number: '01012345678',
        cyber_crime: '010-1234-5678 외부 민감정보',
        privateField: 'private',
        ...extra,
      },
    },
  });
  beforeAll(async () => {
    const url = new URL(process.env.HISTORY_DB_URL!);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      !/^history_test_\d+$/.test(url.pathname.slice(1))
    )
      throw Error('Isolated history test DB required');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    await prisma.$connect();
    previousKey = process.env.APICK_AUTH_KEY;
    process.env.APICK_AUTH_KEY = 'synthetic-key';
    app = await historyTestApp(prisma, image, { post });
    expect(app.get(HttpService).post).toBe(post);
  });
  beforeEach(() => {
    owner = `phone-history-${randomUUID()}`;
    other = `phone-history-${randomUUID()}`;
    post.mockReset().mockReturnValue(of(wire()));
    image.analyze.mockClear();
  });
  afterEach(async () => {
    expect(image.analyze).not.toHaveBeenCalled();
    await prisma.analysis.deleteMany({
      where: { userId: { in: [owner, other] } },
    });
    await prisma.phoneDailyUsage.deleteMany({
      where: { userId: { in: [owner, other] } },
    });
  });
  afterAll(async () => {
    if (previousKey === undefined) delete process.env.APICK_AUTH_KEY;
    else process.env.APICK_AUTH_KEY = previousKey;
    await app?.close();
    await prisma?.$disconnect();
  });
  it('stores masked results and returns saved count/risk/reasons without APICK or usage changes', async () => {
    const created = await create().expect(201),
      id = created.body.analysisId;
    const before = await prisma.analysis.findUniqueOrThrow({
      where: { id },
      include: { phoneResult: true },
    });
    expect(before).toMatchObject({
      userId: owner,
      type: 'PHONE',
      status: 'COMPLETED',
      phoneResult: {
        phoneNumber: '010********',
        riskLevel: 'DANGER',
        reportCount: 1000,
      },
    });
    expect(before.phoneResult?.rawData).toBeNull();
    expect(before.phoneResult?.normalizedData).toBeNull();
    expect(before.expiresAt.getTime() - before.createdAt.getTime()).toBeCloseTo(
      30 * 86400000,
      -2,
    );
    expect(JSON.stringify(before)).not.toMatch(
      /01012345678|010-1234-5678|privateField/,
    );
    const count = await prisma.phoneDailyUsage.findMany({
      where: { userId: owner },
    });
    post.mockClear().mockImplementation(() => {
      throw Error('APICK must not run during history reads');
    });
    const list = await get().expect(200),
      detail = await get(`${path}/${id}`).expect(200);
    expect(list.body.result.items).toEqual([
      {
        analysisId: id,
        type: 'PHONE',
        status: 'COMPLETED',
        targetSummary: '010********',
        aiRiskLevel: 'DANGER',
        createdAt: before.createdAt.toISOString(),
      },
    ]);
    expect(detail.body.result).toMatchObject({
      analysisId: id,
      type: 'PHONE',
      aiGenerationScore: null,
      aiRiskLevel: 'DANGER',
      createdAt: before.createdAt.toISOString(),
      completedAt: before.completedAt!.toISOString(),
      detail: {
        maskedPhoneNumber: '010********',
        riskLevel: 'DANGER',
        reportCount: 1000,
        reportCountIsRange: true,
        analyzedAt: before.phoneResult!.analyzedAt!.toISOString(),
      },
    });
    expect(detail.body.result.reasons).toEqual(
      (before.phoneResult!.reasons as string[]).map((description: string) => ({
        description,
      })),
    );
    expect(JSON.stringify(detail.body)).not.toMatch(
      /rawData|normalizedData|requestHash|userId|synthetic-key|01012345678|010-1234-5678|private/,
    );
    await get(`${path}/${id}`).expect(200);
    expect(post).not.toHaveBeenCalled();
    expect(
      await prisma.analysis.findUnique({
        where: { id },
        include: { phoneResult: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.phoneDailyUsage.findMany({ where: { userId: owner } }),
    ).toEqual(count);
  });
  it.each([
    [0, 'UNKNOWN'],
    [2, 'CAUTION'],
  ])(
    'preserves stored reportCount %s and risk %s',
    async (reportCount, riskLevel) => {
      post.mockReturnValue(
        of(
          wire({ spam: '', spam_count: reportCount, cyber_crime: '<미확인>' }),
        ),
      );
      const id = (await create().expect(201)).body.analysisId;
      post.mockClear();
      const response = await get(`${path}/${id}`).expect(200);
      expect(response.body.result.detail).toMatchObject({
        reportCount,
        riskLevel,
        reportCountIsRange: false,
      });
      expect(post).not.toHaveBeenCalled();
    },
  );
  it('enforces JWT, ownership, expiry and missing-record rules', async () => {
    const id = (await create().expect(201)).body.analysisId;
    post.mockClear();
    await request(app.getHttpServer()).get(path).expect(401);
    await get(`${path}/${id}`, other).expect(404);
    await del(`${path}/${id}`, other).expect(404);
    expect((await get(path, other)).body.result.items).toEqual([]);
    await prisma.analysis.update({
      where: { id },
      data: { expiresAt: new Date(0) },
    });
    await get(`${path}/${id}`).expect(404);
    expect((await get()).body.result.items).toEqual([]);
    await get(`${path}/${randomUUID()}`).expect(404);
    expect(post).not.toHaveBeenCalled();
  });
  it('deletes PHONE child rows by Cascade and preserves other users', async () => {
    const id = (await create().expect(201)).body.analysisId;
    await create('0212345678').expect(201);
    const foreign = (await create('0311234567', other).expect(201)).body
      .analysisId;
    post.mockClear();
    await del(`${path}/${id}`).expect(200);
    expect(
      await prisma.phoneAnalysisResult.findUnique({
        where: { analysisId: id },
      }),
    ).toBeNull();
    await get(`${path}/${id}`).expect(404);
    await del().expect(200);
    await del().expect(200);
    expect((await get()).body.result.items).toEqual([]);
    expect(
      await prisma.phoneAnalysisResult.findUnique({
        where: { analysisId: foreign },
      }),
    ).not.toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
  it('keeps failed analyses and masks their empty result', async () => {
    post.mockReturnValue(
      throwError(() => new Error('synthetic-key 01012345678')),
    );
    const failure = await create().expect(503);
    expect(JSON.stringify(failure.body)).not.toMatch(
      /synthetic-key|01012345678/,
    );
    const row = await prisma.analysis.findFirstOrThrow({
      where: { userId: owner },
    });
    expect(row.status).toBe('FAILED');
    post.mockClear();
    const response = await get(`${path}/${row.id}`).expect(200);
    expect(response.body.result.detail).toEqual({
      maskedPhoneNumber: '010********',
      riskLevel: null,
      reportCount: null,
      reportCountIsRange: null,
      reasons: [],
      analyzedAt: null,
    });
    expect(post).not.toHaveBeenCalled();
  });
  it('protects legacy raw numbers and free-form provider fields at the HTTP boundary', async () => {
    const row = await prisma.analysis.create({
      data: {
        type: 'PHONE',
        userId: owner,
        status: 'COMPLETED',
        requestHash: 'private',
        expiresAt: new Date(Date.now() + 60000),
        aiRiskLevel: '01012345678',
        reasons: [{ description: '01012345678' }],
        phoneResult: {
          create: {
            phoneNumber: '010-1234-5678',
            riskLevel: 'DANGER',
            reportCount: 3,
            reasons: ['02-1234-5678 저장 근거'],
            rawData: { number: '01012345678', key: 'synthetic-key' },
            normalizedData: { number: '01012345678' },
          },
        },
      },
    });
    const list = await get().expect(200),
      detail = await get(`${path}/${row.id}`).expect(200);
    expect(list.body.result.items[0]).toMatchObject({
      targetSummary: '010********',
      aiRiskLevel: 'DANGER',
    });
    expect(detail.body.result.detail.reasons).toEqual(['[REDACTED] 저장 근거']);
    expect(JSON.stringify([list.body, detail.body])).not.toMatch(
      /01012345678|010-1234-5678|02-1234-5678|rawData|normalizedData|synthetic-key/,
    );
    expect(post).not.toHaveBeenCalled();
  });
  it('handles PHONE rows without a related result without inventing data', async () => {
    const row = await prisma.analysis.create({
      data: {
        type: 'PHONE',
        userId: owner,
        status: 'QUEUED',
        requestHash: 'private',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const response = await get(`${path}/${row.id}`).expect(200);
    expect(response.body.result.detail).toMatchObject({
      maskedPhoneNumber: null,
      riskLevel: null,
      reportCount: null,
      reasons: [],
    });
    expect(post).not.toHaveBeenCalled();
  });
  it('documents authenticated common history and PHONE details', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(doc.paths[path].get?.security).toEqual([{ bearer: [] }]);
    expect(
      doc.paths[`${path}/{analysisId}`].get?.responses['404'],
    ).toBeDefined();
    const schema: any = doc.components?.schemas?.PhoneHistoryDetailDto;
    expect(schema.properties.maskedPhoneNumber.example).toBe('010********');
    expect(schema.properties.reportCount.minimum).toBe(0);
  });
});
