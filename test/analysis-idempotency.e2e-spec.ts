import { Prisma } from '@prisma/client';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Analysis DB claim handling', () => {
  const conflict = () =>
    new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
  it('uses one atomic insert and resolves unique conflicts within the user scope', async () => {
    const row = { id: 'existing' };
    const analysis = {
      create: jest.fn().mockRejectedValue(conflict()),
      findUnique: jest.fn().mockResolvedValue(row),
    };
    const repository = new AnalysisRepository({
      analysis,
    } as unknown as PrismaService);
    await expect(
      repository.claim('user', 'hash', new Date(), 'key'),
    ).resolves.toEqual({ analysis: row, claimed: false });
    expect(analysis.findUnique).toHaveBeenCalledWith({
      where: {
        userId_idempotencyKey: { userId: 'user', idempotencyKey: 'key' },
      },
    });
    expect(analysis.create).toHaveBeenCalledTimes(1);
  });
  it('does not treat unrelated database failures as an existing claim', async () => {
    const error = new Error('db unavailable');
    const analysis = {
      create: jest.fn().mockRejectedValue(error),
      findUnique: jest.fn(),
    };
    const repository = new AnalysisRepository({
      analysis,
    } as unknown as PrismaService);
    await expect(
      repository.claim('user', 'hash', new Date(), 'key'),
    ).rejects.toBe(error);
    expect(analysis.findUnique).not.toHaveBeenCalled();
  });
});

describe('abandoned claim recovery fences', () => {
  it('atomically ends only stale active rows, preserving existing errors and terminal results', async () => {
    const cutoff = new Date();
    const analysis = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ status: 'FAILED', errorCode: 'ANALYSIS503' }),
    };
    const repository = new AnalysisRepository({
      analysis,
    } as unknown as PrismaService);
    await repository.terminateStale('id', cutoff);
    expect(analysis.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'id',
        status: { in: ['QUEUED', 'ANALYZING'] },
        createdAt: { lte: cutoff },
        errorCode: null,
      },
      data: {
        status: 'FAILED',
        errorCode: 'ANALYSIS503',
        completedAt: expect.any(Date),
      },
    });
    await repository.fail('id', 'COMMON500');
    expect(analysis.updateMany.mock.calls[1][0].where).toMatchObject({
      status: { in: ['QUEUED', 'ANALYZING'] },
      errorCode: null,
    });
  });
  it('fences a late success write after recovery', async () => {
    const update = jest.fn().mockRejectedValue(new Error('terminal state'));
    const repository = new AnalysisRepository({
      analysis: { update },
    } as unknown as PrismaService);
    await expect(
      repository.complete('id', {
        aiGenerationScore: 10,
        aiRiskLevel: 'LOW',
        reasons: [],
        modelVersion: 'v1',
      }),
    ).rejects.toThrow('terminal state');
    expect(update.mock.calls[0][0].where).toEqual({
      id: 'id',
      NOT: { status: 'FAILED' },
    });
  });
});
