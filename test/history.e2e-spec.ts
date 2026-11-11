import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { HistoryController } from '../src/domains/analysis/history.controller';
import { PrismaService } from '../src/prisma/prisma.service';

describe('integrated history', () => {
  let app: INestApplication;
  const findMany = jest.fn(),
    findFirst = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [HistoryController],
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({ NODE_ENV: 'development' }),
        },
        {
          provide: PrismaService,
          useValue: { analysis: { findMany, findFirst } },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('lists all analysis types with ownership and expiry filters', async () => {
    const items = ['IMAGE', 'TEXT', 'PHONE'].map((type) => ({
      id: randomUUID(),
      type,
    }));
    findMany.mockResolvedValue(items);
    const response = await request(app.getHttpServer())
      .get('/api/history?limit=3')
      .expect(200);
    expect(response.body.result.items).toEqual(items);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: {
        userId: 'development-user',
        expiresAt: { gt: expect.any(Date) },
      },
      take: 3,
    });
    expect(findMany.mock.calls[0][0].select).not.toHaveProperty('requestHash');
  });
  it.each(['0', '101', '1.5', 'abc'])(
    'rejects invalid limit %s',
    async (limit) => {
      await request(app.getHttpServer())
        .get(`/api/history?limit=${limit}`)
        .expect(400);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
  it('does not expose missing, expired or other-user records', async () => {
    findFirst.mockResolvedValue(null);
    const id = randomUUID();
    await request(app.getHttpServer()).get(`/api/history/${id}`).expect(404);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id,
      userId: 'development-user',
      expiresAt: { gt: expect.any(Date) },
    });
    expect(
      findFirst.mock.calls[0][0].select.phoneResult.select,
    ).not.toHaveProperty('rawData');
  });
});
