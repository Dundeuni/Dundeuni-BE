import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { PhoneAnalysisController } from '../src/domains/analysis/phone-analysis.controller';
import { PhoneAnalysisService } from '../src/domains/analysis/phone-analysis.service';
import { PhoneAnalysisRepository } from '../src/domains/analysis/phone-analysis.repository';
import { PhoneRiskService } from '../src/domains/analysis/phone-risk.service';
import { ApickPhoneProvider } from '../src/domains/analysis/apick-phone.provider';
import { AccessTokenGuard } from '../src/common/auth/access-token.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

const secret = 'phone-test-secret';
const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
  'base64url',
);
const payload = Buffer.from(
  JSON.stringify({ sub: 'user-19', exp: 9999999999 }),
).toString('base64url');
const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
const wire = (data: object = {}) => ({
  data: {
    success: 1,
    spam: '',
    spam_count: '0',
    cyber_crime: '최근 3개월 내 3건 이상 접수된 민원이 없습니다.',
    ...data,
  },
  api: { success: true },
});

describe('PB-04 phone analysis (mock HTTP and DB)', () => {
  let app: INestApplication;
  const post = jest.fn();
  const create = jest.fn(),
    update = jest.fn();
  let previousKey: string | undefined;
  beforeAll(async () => {
    previousKey = process.env.APICK_AUTH_KEY;
    const module = await Test.createTestingModule({
      controllers: [PhoneAnalysisController],
      providers: [
        PhoneAnalysisService,
        PhoneAnalysisRepository,
        PhoneRiskService,
        ApickPhoneProvider,
        AccessTokenGuard,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: HttpService, useValue: { post } },
        { provide: PrismaService, useValue: { analysis: { create, update } } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
  });
  afterAll(async () => {
    if (previousKey === undefined) delete process.env.APICK_AUTH_KEY;
    else process.env.APICK_AUTH_KEY = previousKey;
    await app.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.APICK_AUTH_KEY = 'mock-key';
    post.mockReturnValue(of({ status: 200, data: wire() }));
    create.mockResolvedValue({ id: 'd734f69e-ce2e-4914-8a2e-230713d37c96' });
    update.mockResolvedValue({});
  });
  const send = (phoneNumber: unknown = '01012345678') =>
    request(app.getHttpServer())
      .post('/api/analyses/phone')
      .auth(token, { type: 'bearer' })
      .send({ phoneNumber });
  test.each([
    '01012345678',
    '010-1234-5678',
    '02-1234-5678',
    ' 031 123 4567 ',
    '07012345678',
  ])('validates and stores masked %s', async (phone) => {
    const response = await send(phone);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      analysisId: expect.any(String),
      status: 'COMPLETED',
    });
    expect(create.mock.calls[0][0].data).toMatchObject({
      userId: 'user-19',
      type: 'PHONE',
      status: 'ANALYZING',
    });
    expect(
      JSON.stringify([create.mock.calls, update.mock.calls]),
    ).not.toContain(phone.replace(/[\s-]/g, ''));
    expect((post.mock.calls[0][1] as FormData).get('number')).toBe(
      phone.replace(/[\s-]/g, ''),
    );
    expect(update.mock.calls[0][0].data.phoneResult.update.riskLevel).toBe(
      'UNKNOWN',
    );
  });
  test.each([
    null,
    123,
    '',
    'abc',
    '0101234',
    '99912345678',
    '010+12345678',
    '0'.repeat(65),
  ])('rejects invalid input %s', async (value) => {
    expect((await send(value)).body.code).toBe('INVALID_PHONE_NUMBER');
    expect(create).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  test('requires JWT', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/analyses/phone')
          .send({ phoneNumber: '01012345678' })
      ).status,
    ).toBe(401);
    expect(post).not.toHaveBeenCalled();
  });
  test('normalizes range counts and preserves source, excludes number', async () => {
    post.mockReturnValue(
      of({
        status: 200,
        data: wire({
          number: '01012345678',
          spam: '보이스피싱',
          spam_count: '1000+',
          registed_date: '2024-06-18',
        }),
      }),
    );
    expect((await send()).status).toBe(201);
    expect(update.mock.calls[0][0].data.phoneResult.update).toMatchObject({
      reportCount: 1000,
      reportCountRaw: '1000+',
      riskLevel: 'DANGER',
      normalizedData: {
        reportCountIsRange: true,
        registeredDate: '2024-06-18',
      },
    });
  });
  test.each([{}, { spam: null, spam_count: null }, { spam_count: 2 }])(
    'handles missing/null/numeric fields %j',
    async (fields) => {
      post.mockReturnValue(
        of({
          status: 200,
          data: { data: { success: 1, ...fields }, api: { success: true } },
        }),
      );
      expect((await send()).status).toBe(201);
    },
  );
  test.each([
    [500, {}, 'EXTERNAL_API_UNAVAILABLE'],
    [
      200,
      { result: { error: '사용 가능한 포인트이 부족합니다.' } },
      'APICK_QUOTA_EXCEEDED',
    ],
    [429, {}, 'APICK_QUOTA_EXCEEDED'],
    [401, {}, 'APICK_AUTHENTICATION_FAILED'],
    [200, wire({ success: 0 }), 'EXTERNAL_API_UNAVAILABLE'],
    [200, wire({ spam_count: 'bad' }), 'EXTERNAL_API_UNAVAILABLE'],
    [
      200,
      { data: { success: 1 }, api: { success: false } },
      'EXTERNAL_API_UNAVAILABLE',
    ],
  ])('handles upstream status %s %j', async (status, data, code) => {
    post.mockReturnValue(of({ status, data }));
    const response = await send();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe(code);
    expect(update.mock.calls.at(-1)[0].data).toMatchObject({
      status: 'FAILED',
      errorCode: code,
    });
  });
  test.each(['timeout', 'network'])(
    'handles %s without exposing upstream details',
    async (message) => {
      post.mockReturnValue(
        throwError(() => new Error(`${message} mock-key 01012345678`)),
      );
      const response = await send();
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toMatch(/mock-key|01012345678/);
    },
  );
  test('reports missing key and records failure', async () => {
    delete process.env.APICK_AUTH_KEY;
    expect((await send()).body.code).toBe('APICK_CONFIGURATION_ERROR');
    expect(post).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.status).toBe('FAILED');
  });
  test('handles request persistence failure before external call', async () => {
    create.mockRejectedValue(new Error('db secret'));
    expect((await send()).body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(post).not.toHaveBeenCalled();
  });
  test('records failed result write', async () => {
    update.mockRejectedValueOnce(new Error('db'));
    expect((await send()).status).toBe(500);
    expect(update.mock.calls[1][0].data.status).toBe('FAILED');
  });
  test('handles failure-state persistence error', async () => {
    update.mockRejectedValue(new Error('db'));
    expect((await send()).body.code).toBe('INTERNAL_SERVER_ERROR');
  });
  test('documents route and authentication', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    expect(doc.paths['/api/analyses/phone'].post?.security).toEqual([
      { bearer: [] },
    ]);
    expect(
      doc.paths['/api/analyses/phone'].post?.responses['201'],
    ).toBeDefined();
  });
});

describe('Phone risk policy unit tests', () => {
  const service = new PhoneRiskService();
  const base = {
    spamType: null,
    reportCount: null,
    reportCountRaw: null,
    reportCountIsRange: false,
    cyberCrime: null,
    registeredDate: null,
    success: 1,
    rawData: {},
  };
  test.each([
    [{}, 'UNKNOWN'],
    [{ reportCount: 1000 }, 'CAUTION'],
    [{ spamType: 'SMS 피싱' }, 'DANGER'],
    [{ cyberCrime: '<미확인>' }, 'UNKNOWN'],
    [
      { cyberCrime: '최근 3개월 내 3건 이상 접수된 민원이 없습니다.' },
      'UNKNOWN',
    ],
    [{ cyberCrime: '신고 내역 확인 필요' }, 'CAUTION'],
  ])('classifies evidence %j as %s', (fields, expected) => {
    const result = service.assess({ ...base, ...fields });
    expect(result.riskLevel).toBe(expected);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.policyVersion).toBe('phone-initial-1');
  });
});
