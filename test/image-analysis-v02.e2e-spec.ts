import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { MockImageAnalysisProvider } from '../src/domains/analysis/mock-image-analysis.provider';
import { AiImageAnalysisRequestV1 } from '../src/domains/analysis/image-analysis.service';
import { validateAiImageResponseV02 } from '../src/domains/analysis/image-analysis-v1.validator';
import { validateLocalization } from '../src/domains/analysis/image-localization.validator';
import {
  calculateOverallResult,
  pilotDecision,
  pilotDisplayScore,
} from '../src/domains/analysis/image-analysis-policy';
const file = { buffer: Buffer.from('fixture') } as Express.Multer.File;
const request = (
  models: AiImageAnalysisRequestV1['models'] = 'ALL',
): AiImageAnalysisRequestV1 => ({
  file,
  analysisId: randomUUID(),
  elementId: randomUUID(),
  requestId: randomUUID(),
  sourceType: 'IMAGE',
  models,
  deadlineAt: new Date(Date.now() + 1000).toISOString(),
});
describe('CuRe + TruFor v0.2', () => {
  it.each([
    [
      'BOTH_SUCCESS',
      'COMPLETED',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      ['generation', 'manipulation'],
      [],
    ],
    [
      'GENERATION_SUSPECTED',
      'COMPLETED',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      ['generation'],
      [],
    ],
    [
      'MANIPULATION_SUSPECTED',
      'COMPLETED',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      ['manipulation'],
      [],
    ],
    ['NO_CLEAR_SIGNAL', 'COMPLETED', 'NO_CLEAR_SIGNAL', [], []],
    [
      'INCONCLUSIVE',
      'COMPLETED',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      ['manipulation'],
      ['generation'],
    ],
    [
      'BOTH_INCONCLUSIVE',
      'COMPLETED',
      'INCONCLUSIVE',
      [],
      ['generation', 'manipulation'],
    ],
    [
      'GENERATION_FAILED',
      'PARTIAL_FAILED',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      ['manipulation'],
      ['generation'],
    ],
    [
      'MANIPULATION_FAILED',
      'PARTIAL_FAILED',
      'GENERATION_OR_MANIPULATION_SUSPECTED',
      ['generation'],
      ['manipulation'],
    ],
    [
      'BOTH_FAILED',
      'FAILED',
      'INCONCLUSIVE',
      [],
      ['generation', 'manipulation'],
    ],
  ] as const)(
    'validates %s with independent execution/overall decisions',
    async (scenario, status, decision, suspected, uncertain) => {
      const response = validateAiImageResponseV02(
        await new MockImageAnalysisProvider(scenario).analyze(file, request()),
      );
      expect(response.contractVersion).toBe('1.0');
      expect(response.generation?.modelName).toBe('CuRe');
      expect(response.status).toBe(status);
      expect(response.overallResult).toMatchObject({
        decision,
        policyVersion: 'image-overall-v1',
        suspectedKinds: [...suspected],
        uncertainKinds: [...uncertain],
      });
      expect(response.overallResult).not.toHaveProperty('score');
      for (const model of [response.generation, response.manipulation])
        if (model?.status === 'FAILED') {
          expect(model).toMatchObject({
            rawScore: null,
            displayScore: null,
            decision: null,
            decisionLabel: null,
            localization: null,
            reasons: [],
            limitations: [],
          });
        }
    },
  );
  it.each(['GENERATION', 'MANIPULATION'] as const)(
    'supports %s-only and marks missing models uncertain',
    async (models) => {
      const response = validateAiImageResponseV02(
        await new MockImageAnalysisProvider('NO_CLEAR_SIGNAL').analyze(
          file,
          request(models),
        ),
      );
      expect(response.status).toBe('COMPLETED');
      expect(response.overallResult.decision).toBe('INCONCLUSIVE');
      expect(response.overallResult.uncertainKinds).toEqual([
        models === 'GENERATION' ? 'manipulation' : 'generation',
      ]);
    },
  );
  it.each([
    ['generation', 0.000003999, 'NO_CLEAR_GENERATION_SIGNAL', 0],
    ['generation', 0.000004, 'INCONCLUSIVE', null],
    ['generation', 0.01999999, 'INCONCLUSIVE', null],
    ['generation', 0.02, 'AI_GENERATED_SUSPECTED', 2],
    ['manipulation', 0.119999, 'NO_CLEAR_MANIPULATION_SIGNAL', 12],
    ['manipulation', 0.12, 'INCONCLUSIVE', null],
    ['manipulation', 0.699999, 'INCONCLUSIVE', null],
    ['manipulation', 0.7, 'MANIPULATION_SUSPECTED', 70],
    ['manipulation', 0.7049, 'MANIPULATION_SUSPECTED', 70],
    ['manipulation', 0.705, 'MANIPULATION_SUSPECTED', 71],
  ] as const)(
    'uses unrounded %s score %s',
    (kind, score, decision, display) => {
      expect(pilotDecision(kind, score)).toBe(decision);
      expect(pilotDisplayScore(score, decision)).toBe(display);
    },
  );
  it('does not treat a failed or unrequested model as a clear signal', () => {
    const clear = {
      status: 'SUCCEEDED' as const,
      decision: 'NO_CLEAR_GENERATION_SIGNAL' as const,
    };
    const failed = { status: 'FAILED' as const, decision: null };
    expect(calculateOverallResult(clear, failed).decision).toBe('INCONCLUSIVE');
    expect(calculateOverallResult(failed, clear).decision).toBe('INCONCLUSIVE');
    expect(calculateOverallResult(clear, null).decision).toBe('INCONCLUSIVE');
    expect(calculateOverallResult(null, clear).decision).toBe('INCONCLUSIVE');
  });
  it('validates an actually decodable PNG and nullable localization', async () => {
    const response = await new MockImageAnalysisProvider(
      'LOCALIZATION',
    ).analyze(file, request());
    expect(() => validateAiImageResponseV02(response)).not.toThrow();
    const map = response.manipulation!.localization!;
    expect(PNG.sync.read(Buffer.from(map.data, 'base64')).width).toBe(1);
    expect(() => validateLocalization(null)).not.toThrow();
  });
  it.each([
    'base64',
    'signature',
    'crc',
    'dimensions',
    'coordinate',
    'format',
    'ratio',
    'oversize',
    'map-size',
    'truncated',
  ])('rejects invalid localization %s', async (invalid) => {
    const response = await new MockImageAnalysisProvider(
      'LOCALIZATION',
    ).analyze(file, request());
    const map = structuredClone(response.manipulation!.localization!);
    if (invalid === 'base64') map.data = '%%%';
    if (invalid === 'signature') map.data = Buffer.alloc(50).toString('base64');
    if (invalid === 'crc') {
      const bytes = Buffer.from(map.data, 'base64');
      bytes[29] ^= 1;
      map.data = bytes.toString('base64');
    }
    if (invalid === 'dimensions') {
      map.mapSize = { width: 2, height: 2 };
      map.imageSize = { width: 2, height: 2 };
    }
    if (invalid === 'coordinate') map.coordinateSpace = 'WRONG' as any;
    if (invalid === 'format') map.format = 'WRONG' as any;
    if (invalid === 'ratio') map.imageSize = { width: 100, height: 1 };
    if (invalid === 'oversize')
      map.data = Buffer.alloc(1048577).toString('base64');
    if (invalid === 'map-size') map.mapSize = { width: 1025, height: 1025 };
    if (invalid === 'truncated')
      map.data = Buffer.from(map.data, 'base64')
        .subarray(0, 33)
        .toString('base64');
    expect(() => validateLocalization(map)).toThrow();
  });
  it('rejects obsolete contract versions', async () => {
    const response = await new MockImageAnalysisProvider(
      'BOTH_SUCCESS',
    ).analyze(file, request());
    expect(() =>
      validateAiImageResponseV02({
        ...response,
        contractVersion: 'v1-mock-draft',
      }),
    ).toThrow();
  });
  it('rejects inconsistent pilot and overall data', async () => {
    const valid = await new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
      file,
      request(),
    );
    expect(() =>
      validateAiImageResponseV02({
        ...valid,
        overallResult: { ...valid.overallResult, suspectedKinds: [] },
      }),
    ).toThrow();
    expect(() =>
      validateAiImageResponseV02({
        ...valid,
        generation: { ...valid.generation, rawScore: { score: 0.01 } },
      }),
    ).toThrow();
    expect(calculateOverallResult(null, null).decision).toBe('INCONCLUSIVE');
  });
});
