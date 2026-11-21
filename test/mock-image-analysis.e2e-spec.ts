import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  MockImageAnalysisProvider,
  MOCK_SCENARIOS,
  selectImageAnalysisProvider,
} from '../src/domains/analysis/mock-image-analysis.provider';
import {
  AiImageAnalysisRequestV1,
  ImageAnalysisService,
} from '../src/domains/analysis/image-analysis.service';
import { validateAiImageResponseV1 } from '../src/domains/analysis/image-analysis-v1.validator';
const file = {
  buffer: Buffer.from('test'),
  mimetype: 'image/png',
} as Express.Multer.File;
const request = (): AiImageAnalysisRequestV1 => ({
  file,
  analysisId: randomUUID(),
  elementId: randomUUID(),
  requestId: randomUUID(),
  sourceType: 'IMAGE',
  models: 'ALL',
  deadlineAt: new Date(Date.now() + 1000).toISOString(),
});
describe('Mock AI Provider', () => {
  it.each(MOCK_SCENARIOS.filter((s) => s !== 'TIMEOUT'))(
    'returns valid deterministic model data for %s',
    async (scenario) => {
      const provider = new MockImageAnalysisProvider(scenario);
      const first = validateAiImageResponseV1(
        await provider.analyze(file, request()),
      );
      const second = await provider.analyze(file, request());
      expect(first.generation).toEqual(second.generation);
      expect(first.manipulation).toEqual(second.manipulation);
      if (scenario === 'BOTH_FAILED') expect(first.status).toBe('FAILED');
      if (scenario === 'INCONCLUSIVE')
        expect(first.generation).toMatchObject({
          status: 'SUCCEEDED',
          decision: 'INCONCLUSIVE',
          displayScore: null,
        });
    },
  );
  it('returns null for unrequested models', async () => {
    const response = await new MockImageAnalysisProvider(
      'BOTH_SUCCESS',
    ).analyze(file, { ...request(), models: 'GENERATION' });
    expect(response.manipulation).toBeNull();
    expect(response.requestedModels).toEqual(['GENERATION']);
  });
  it('bounds TIMEOUT by configured deadline', async () => {
    const service = new ImageAnalysisService(
      new MockImageAnalysisProvider('TIMEOUT'),
      new ConfigService({ AI_REQUEST_TIMEOUT_MS: '5' }),
    );
    await expect(service.analyze(file, request())).rejects.toMatchObject({
      status: 503,
    });
  });
  it('rejects unknown and production mock configurations', () => {
    expect(() =>
      selectImageAnalysisProvider(new ConfigService({ AI_PROVIDER: 'wrong' })),
    ).toThrow();
    expect(() =>
      selectImageAnalysisProvider(
        new ConfigService({ AI_PROVIDER: 'mock', NODE_ENV: 'production' }),
      ),
    ).toThrow();
    expect(() =>
      selectImageAnalysisProvider(
        new ConfigService({ AI_PROVIDER: 'mock', AI_MOCK_SCENARIO: 'wrong' }),
      ),
    ).toThrow();
  });
  it('selects the configured development mock and validates timeout at startup', () => {
    expect(
      selectImageAnalysisProvider(
        new ConfigService({
          AI_PROVIDER: 'mock',
          NODE_ENV: 'development',
          AI_MOCK_SCENARIO: 'BOTH_SUCCESS',
        }),
      ),
    ).toBeInstanceOf(MockImageAnalysisProvider);
    expect(() =>
      selectImageAnalysisProvider(
        new ConfigService({ AI_REQUEST_TIMEOUT_MS: '0' }),
      ),
    ).toThrow();
  });
  it('reports unimplemented HTTP configuration clearly', async () => {
    await expect(
      selectImageAnalysisProvider(
        new ConfigService({ AI_PROVIDER: 'http' }),
      ).analyze(file, request()),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        code: 'ANALYSIS503',
        message: 'HTTP AI Provider가 아직 구현되지 않았습니다.',
      },
    });
  });
  it('rejects invalid v1 score even with HTTP success', async () => {
    const valid = await new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
      file,
      request(),
    );
    const provider = {
      analyze: async () => ({
        ...valid,
        generation: { ...valid.generation, displayScore: 101 },
      }),
    };
    await expect(
      new ImageAnalysisService(provider, new ConfigService()).analyze(
        file,
        request(),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('AI timeout boundaries', () => {
  it.each(['1', '2147483647'])('accepts %s ms', async (value) => {
    const config = new ConfigService({ AI_REQUEST_TIMEOUT_MS: value });
    expect(() => selectImageAnalysisProvider(config)).not.toThrow();
    const result = {
      aiGenerationScore: 10,
      aiRiskLevel: 'LOW',
      reasons: [],
      modelVersion: 'test',
    };
    await expect(
      new ImageAnalysisService({ analyze: async () => result }, config).analyze(
        file,
      ),
    ).resolves.toEqual(result);
  });
  it.each(['0', '-1', 'NaN', '', '1.5', '2147483648', '9007199254740991'])(
    'rejects invalid timeout %s before provider execution',
    async (value) => {
      const config = new ConfigService({ AI_REQUEST_TIMEOUT_MS: value });
      expect(() => selectImageAnalysisProvider(config)).toThrow(
        'AI_REQUEST_TIMEOUT_MS',
      );
      const provider = { analyze: jest.fn() };
      await expect(
        new ImageAnalysisService(provider, config).analyze(file),
      ).rejects.toMatchObject({ status: 503 });
      expect(provider.analyze).not.toHaveBeenCalled();
    },
  );
});
