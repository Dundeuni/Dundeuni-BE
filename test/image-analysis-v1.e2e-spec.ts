import {
  AiImageAnalysisResponseV1,
  AiModelResultV1,
  ImageModelPublicResultDto,
} from '../src/domains/analysis/image-analysis-v1.dto';
import { validateAiImageResponseV1 } from '../src/domains/analysis/image-analysis-v1.validator';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { PrismaService } from '../src/prisma/prisma.service';

const model = (
  status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
): AiModelResultV1 => ({
  status,
  modelName: 'test',
  modelVersion: '1',
  policyVersion: '1',
  rawScore: 0.82,
  displayScore: status === 'SUCCEEDED' ? 82 : null,
  decision: status === 'FAILED' ? null : 'INCONCLUSIVE',
  reasons: [],
  limitations: [],
  localization: null,
  errorCode: status === 'FAILED' ? 'MODEL_FAILED' : null,
  error: status === 'FAILED' ? { code: 'MODEL_FAILED' } : null,
});
const root = (
  generation: AiModelResultV1 | null = model(),
  manipulation: AiModelResultV1 | null = model(),
  status: AiImageAnalysisResponseV1['status'] = 'COMPLETED',
): AiImageAnalysisResponseV1 => ({
  contractVersion: 'v1-fixture',
  requestId: 'request',
  analysisId: 'analysis',
  elementId: null,
  sourceType: 'fixture-unconfirmed',
  requestedModels: [],
  status,
  analysisImage: null,
  generation,
  manipulation,
  completedAt: '2026-10-12T00:00:00Z',
});
// wire fixture는 실제 AI 계약 예시가 아닌 알려진 구조 규칙 검증용이다.
describe('AI v1 known contract rules', () => {
  it.each([
    root(),
    root(model(), model('FAILED'), 'PARTIAL_FAILED'),
    root(model('FAILED'), model(), 'PARTIAL_FAILED'),
    root(model('FAILED'), model('FAILED'), 'FAILED'),
    root({ ...model(), displayScore: null }),
    root(model(), null),
    root(null, model()),
  ])(
    'accepts success, partial failure, failure, null scores and unrequested null models',
    (value) => {
      expect(validateAiImageResponseV1(value)).toBe(value);
    },
  );
  it('allows INCONCLUSIVE without generating a risk level', () => {
    expect(validateAiImageResponseV1(root()).generation?.decision).toBe(
      'INCONCLUSIVE',
    );
  });
  it.each([-1, 101, 1.5, '82', undefined, NaN])(
    'rejects invalid displayScore %s',
    (score) => {
      expect(() =>
        validateAiImageResponseV1(
          root({ ...model(), displayScore: score as number }),
        ),
      ).toThrow();
    },
  );
  it('rejects missing fields and mismatched model errors', () => {
    const missing = { ...model() };
    delete (missing as any).policyVersion;
    expect(() => validateAiImageResponseV1(root(missing))).toThrow();
    expect(() =>
      validateAiImageResponseV1(
        root({ ...model('FAILED'), error: { code: 'OTHER' } }),
      ),
    ).toThrow();
    expect(() =>
      validateAiImageResponseV1({ ...root(), completedAt: undefined }),
    ).toThrow();
  });
  it('rejects contradictory aggregate and model statuses', () => {
    expect(() =>
      validateAiImageResponseV1(root(model(), model('FAILED'), 'COMPLETED')),
    ).toThrow();
    expect(() =>
      validateAiImageResponseV1(root(model(), model(), 'FAILED')),
    ).toThrow();
    expect(() =>
      validateAiImageResponseV1(root(model(), null, 'PARTIAL_FAILED')),
    ).toThrow();
  });
  it.each([
    { decision: 'INCONCLUSIVE', displayScore: null },
    { decision: null, displayScore: 50 },
  ])('rejects FAILED with non-null decision or score', (invalid) => {
    expect(() =>
      validateAiImageResponseV1(
        root(
          { ...model('FAILED'), ...invalid } as AiModelResultV1,
          null,
          'FAILED',
        ),
      ),
    ).toThrow();
  });
  it('rejects generation localization', () => {
    expect(() =>
      validateAiImageResponseV1(
        root({ ...model(), localization: { opaque: true } }),
      ),
    ).toThrow();
  });
});

const normalized = (
  status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
): ImageModelPublicResultDto => ({
  status,
  modelName: 'test',
  modelVersion: '1',
  policyVersion: '1',
  displayScore: status === 'SUCCEEDED' ? 82 : null,
  decision: status === 'FAILED' ? null : 'INCONCLUSIVE',
  reasons: [{ description: 'test' }],
  limitations: ['test'],
  errorCode: status === 'FAILED' ? 'MODEL_FAILED' : null,
  retryable: null,
});
describe('V1 repository writes (Prisma mock)', () => {
  let repository: AnalysisRepository;
  const prisma = {
    analysisModelResult: { upsert: jest.fn() },
    analysis: { update: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  beforeEach(() => {
    jest.clearAllMocks();
    repository = new AnalysisRepository(prisma as unknown as PrismaService);
  });
  it.each([
    ['COMPLETED', normalized(), normalized()],
    ['PARTIAL_FAILED', normalized(), normalized('FAILED')],
    ['PARTIAL_FAILED', normalized('FAILED'), normalized()],
    ['FAILED', normalized('FAILED'), normalized('FAILED')],
  ] as const)(
    'stores %s independently without changing BE status',
    async (status, generation, manipulation) => {
      await repository.saveModelResults('analysis', {
        status,
        generation,
        manipulation,
      });
      expect(prisma.analysisModelResult.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.analysis.update).toHaveBeenCalledWith({
        where: { id: 'analysis' },
        data: { imageResultStatus: status },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );
  it('does not overwrite unrequested models or persist forbidden/extra fields', async () => {
    const value = {
      ...normalized(),
      rawScore: 0.8,
      localization: { png: 'secret' },
      crop: 'secret',
      reasons: [{ description: 'test', image: 'secret' }],
    };
    await repository.saveModelResults('analysis', {
      status: 'COMPLETED',
      generation: value,
      manipulation: null,
    });
    expect(prisma.analysisModelResult.upsert).toHaveBeenCalledTimes(1);
    const write = prisma.analysisModelResult.upsert.mock.calls[0][0];
    expect(write.create).not.toHaveProperty('rawScore');
    expect(write.create).not.toHaveProperty('localization');
    expect(write.create).not.toHaveProperty('crop');
    expect(write.create.reasons).toEqual([{ description: 'test' }]);
  });
  it.each([
    { decision: 'INCONCLUSIVE', displayScore: null },
    { decision: null, displayScore: 50 },
  ])(
    'repository rejects invalid FAILED payload before writing',
    async (invalid) => {
      await expect(
        repository.saveModelResults('analysis', {
          status: 'FAILED',
          generation: {
            ...normalized('FAILED'),
            ...invalid,
          } as ImageModelPublicResultDto,
          manipulation: null,
        }),
      ).rejects.toThrow();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it('propagates transaction failures', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('database'));
    await expect(
      repository.saveModelResults('analysis', {
        status: 'COMPLETED',
        generation: normalized(),
        manipulation: null,
      }),
    ).rejects.toThrow('database');
  });
  it('queries related models and tolerates null summaries in old records', async () => {
    prisma.analysis.findUnique.mockResolvedValueOnce({
      id: 'analysis',
      summary: null,
      summaryStatus: null,
      summaryModel: null,
      summarizedAt: null,
      modelResults: [],
    });
    expect(await repository.findWithModelResults('analysis')).toMatchObject({
      summaryStatus: null,
      modelResults: [],
    });
  });
  it('separates pending, failed and completed summaries', async () => {
    await repository.saveSummary('analysis', { status: 'PENDING' });
    expect(prisma.analysis.update.mock.calls[0][0].data).toMatchObject({
      summaryStatus: 'PENDING',
      summary: null,
      summarizedAt: null,
    });
    await repository.saveSummary('analysis', { status: 'FAILED' });
    expect(prisma.analysis.update.mock.calls[1][0].data).toMatchObject({
      summaryStatus: 'FAILED',
      summary: null,
    });
    await repository.saveSummary('analysis', {
      status: 'COMPLETED',
      summary: 'summary',
      model: 'future',
      summarizedAt: new Date(),
    });
    expect(prisma.analysis.update.mock.calls[2][0].data).toMatchObject({
      summaryStatus: 'COMPLETED',
      summary: 'summary',
    });
  });
});
