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
