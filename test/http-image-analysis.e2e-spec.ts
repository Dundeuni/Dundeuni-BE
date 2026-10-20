import { ConfigService } from '@nestjs/config';
import { ApiError } from '../src/common/http/api-error';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { HttpImageAnalysisProvider } from '../src/domains/analysis/http-image-analysis.provider';
import {
  ImageAnalysisService,
  AiImageAnalysisRequestV1,
} from '../src/domains/analysis/image-analysis.service';
import {
  MockImageAnalysisProvider,
  selectImageAnalysisProvider,
} from '../src/domains/analysis/mock-image-analysis.provider';
import { validateAiImageResponseV02 } from '../src/domains/analysis/image-analysis-v1.validator';
import { validateLocalization } from '../src/domains/analysis/image-localization.validator';
const makeFile = () => {
  const buffer = PNG.sync.write(new PNG({ width: 32, height: 32 }));
  return {
    buffer,
    size: buffer.length,
    mimetype: 'image/png',
    originalname: 'private-original.png',
  } as Express.Multer.File;
};
const context = (file: Express.Multer.File): AiImageAnalysisRequestV1 => ({
  file,
  analysisId: randomUUID(),
  elementId: randomUUID(),
  requestId: randomUUID(),
  sourceType: 'IMAGE',
  models: 'ALL',
  deadlineAt: new Date(Date.now() + 5000).toISOString(),
});
const settings = () =>
  new ConfigService({
    AI_SERVER_BASE_URL: 'http://127.0.0.1:1',
    AI_SERVICE_TOKEN: 'test-only-token',
    AI_REQUEST_TIMEOUT_MS: '1000',
  });

describe('v0.2 real HTTP transport with mocked HTTP', () => {
  afterEach(() => jest.restoreAllMocks());
  it('sends exact multipart fields and headers over loopback HTTP and projects wire results', async () => {
    const file = makeFile(),
      ctx = context(file);
    // Independent fixture transcribed from the provided contract, without optional modelName.
    const wire = {
      contractVersion: '1.0',
      requestId: ctx.requestId,
      analysisId: ctx.analysisId,
      elementId: ctx.elementId,
      sourceType: ctx.sourceType,
      requestedModels: ['generation', 'manipulation'],
      status: 'COMPLETED',
      analysisImage: {
        inputSha256: createHash('sha256').update(file.buffer).digest('hex'),
        width: 32,
        height: 32,
        normalizationVersion: 'fixture-v1',
      },
      generation: {
        status: 'SUCCEEDED',
        rawScore: { score: 0.8 },
        displayScore: 80,
        decision: 'AI_GENERATED_SUSPECTED',
        decisionLabel: 'AI 생성 의심',
        reasons: ['점수에서 AI 생성 의심 신호가 나타났습니다.'],
        limitations: ['원본 인증이 아닙니다.'],
        modelVersion: 'cure-fixture-v1',
        policyVersion: 'fixture-policy',
        localization: null,
        errorCode: null,
        error: null,
      },
      manipulation: {
        status: 'SUCCEEDED',
        rawScore: { score: 0.1 },
        displayScore: 10,
        decision: 'NO_CLEAR_MANIPULATION_SIGNAL',
        decisionLabel: '뚜렷한 변조 신호 없음',
        reasons: ['점수에서 뚜렷한 변조 신호가 없습니다.'],
        limitations: ['안전성을 보장하지 않습니다.'],
        modelVersion: 'trufor-fixture-v1',
        policyVersion: 'fixture-policy',
        localization: null,
        errorCode: null,
        error: null,
      },
      overallResult: {
        decision: 'GENERATION_OR_MANIPULATION_SUSPECTED',
        decisionLabel: '생성·변조 의심',
        policyVersion: 'image-overall-v1',
        suspectedKinds: ['generation'],
        uncertainKinds: [],
      },
      completedAt: new Date().toISOString(),
    };
    let received:
      | {
          url?: string;
          method?: string;
          headers: Record<string, unknown>;
          body: Buffer;
        }
      | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks),
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(wire));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const config = settings();
      config.set(
        'AI_SERVER_BASE_URL',
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      );
      config.set('AI_PROVIDER', 'http');
      const provider = selectImageAnalysisProvider(config);
      expect(provider).toBeInstanceOf(HttpImageAnalysisProvider);
      const result = await new ImageAnalysisService(provider, config).analyze(
        file,
        ctx,
      );
      if (!('format' in result))
        throw new Error('Expected projected model results');
      expect(result.models.generation).toMatchObject({
        modelName: 'CuRe',
        displayScore: 80,
        reasons: [{ description: wire.generation!.reasons[0] }],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /rawScore|localization|inputSha256/,
      );
      expect(received).toMatchObject({
        url: '/internal/v1/image-analyses',
        method: 'POST',
        headers: {
          authorization: 'Bearer test-only-token',
          'x-request-id': ctx.requestId,
        },
      });
      const body = received!.body.toString('latin1');
      expect(
        [...body.matchAll(/name="([^"\r\n]+)"/g)]
          .map((match) => match[1])
          .filter((name) => name !== 'analysis.png'),
      ).toEqual([
        'file',
        'analysisId',
        'elementId',
        'sourceType',
        'models',
        'deadlineAt',
      ]);
      expect(body).not.toContain('private-original');
      expect(body).not.toContain('name="requestId"');
      for (const value of [
        ctx.analysisId,
        ctx.elementId,
        ctx.deadlineAt,
        'ALL',
        'IMAGE',
      ])
        expect(body).toContain(value);
      expect(received!.body.includes(file.buffer)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it.each([
    ['GENERATION_FAILED', 'PARTIAL_FAILED', 'FAILED', 'SUCCEEDED'],
    ['MANIPULATION_FAILED', 'PARTIAL_FAILED', 'SUCCEEDED', 'FAILED'],
    ['BOTH_FAILED', 'FAILED', 'FAILED', 'FAILED'],
  ] as const)(
    'projects HTTP 200 %s while preserving both model results',
    async (scenario, status, generationStatus, manipulationStatus) => {
      const file = makeFile(),
        ctx = context(file);
      const wire = await new MockImageAnalysisProvider(scenario).analyze(
        file,
        ctx,
      );
      const fetcher = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json(wire));
      const result = await new ImageAnalysisService(
        new HttpImageAnalysisProvider(settings()),
        settings(),
      ).analyze(file, ctx);
      if (!('format' in result)) throw new Error('Expected model projection');
      expect(result.models).toMatchObject({
        status,
        generation: { status: generationStatus },
        manipulation: { status: manipulationStatus },
      });
      for (const model of [
        result.models.generation,
        result.models.manipulation,
      ]) {
        expect(model).not.toBeNull();
        if (model!.status === 'FAILED')
          expect(model).toMatchObject({
            decision: null,
            displayScore: null,
            reasons: [],
            limitations: [],
            errorCode: 'MOCK_MODEL_FAILED',
            retryable: false,
          });
      }
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    [400, 400],
    [422, 400],
    [413, 413],
    [415, 415],
    [401, 503],
    [403, 503],
    [429, 503],
    [500, 503],
    [503, 503],
    [504, 503],
    [302, 503],
  ])(
    'maps upstream %i to public %i without leaking its body or retrying',
    async (upstream, expected) => {
      const fetcher = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: 'test-only-token private trace' },
          }),
          { status: upstream },
        ),
      );
      const file = makeFile();
      await expect(
        new HttpImageAnalysisProvider(settings()).analyze(file, context(file)),
      ).rejects.toMatchObject({
        status: expected,
        response: {
          code: expected === 503 ? 'ANALYSIS503' : `COMMON${expected}`,
          result: null,
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['invalid JSON', JSON.stringify({ aiGenerationScore: 80 }), 'null'])(
    'rejects an HTTP 200 invalid envelope: %s',
    async (body) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
      const file = makeFile();
      await expect(
        new HttpImageAnalysisProvider(settings()).analyze(file, context(file)),
      ).rejects.toMatchObject({ status: 503 });
    },
  );
  it.each(['requestId', 'deadlineAt', 'sourceType', 'models'])(
    'rejects invalid %s before HTTP',
    async (key) => {
      const fetcher = jest.spyOn(globalThis, 'fetch');
      const file = makeFile(),
        ctx = context(file);
      Object.assign(ctx, { [key]: 'invalid' });
      await expect(
        new HttpImageAnalysisProvider(settings()).analyze(file, ctx),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('handles network failure', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('secret network detail'));
    const file = makeFile();
    const error = await new HttpImageAnalysisProvider(settings())
      .analyze(file, context(file))
      .catch((error) => error);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError))
      throw new Error('Expected a sanitized ApiError');
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      isSuccess: false,
      code: 'ANALYSIS503',
      message: '이미지 분석을 수행할 수 없습니다.',
      result: null,
    });
    expect(JSON.stringify(error.getResponse())).not.toContain(
      'secret network detail',
    );
  });
  it('rejects an expired deadline without sending an HTTP request', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch');
    const file = makeFile();
    await expect(
      new HttpImageAnalysisProvider(settings()).analyze(file, {
        ...context(file),
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds a stalled transport by timeout and aborts the request', async () => {
    const config = settings();
    config.set('AI_REQUEST_TIMEOUT_MS', '5');
    let signal: AbortSignal | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init!.signal as AbortSignal;
          if (signal.aborted) reject(new Error('aborted'));
          else
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
        }),
    );
    const file = makeFile();
    await expect(
      new HttpImageAnalysisProvider(config).analyze(file, context(file)),
    ).rejects.toMatchObject({ status: 503 });
    expect(signal!.aborted).toBe(true);
  });
  it('does not send a request when already aborted or when file exceeds 10 MiB', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch');
    const file = makeFile();
    const abort = new AbortController();
    abort.abort();
    await expect(
      new HttpImageAnalysisProvider(settings()).analyze(
        file,
        context(file),
        abort.signal,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const large = { ...file, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) };
    await expect(
      new HttpImageAnalysisProvider(settings()).analyze(large, context(large)),
    ).rejects.toMatchObject({ status: 413 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['url', 'token', 'protocol', 'embedded-credentials'])(
    'fails closed on invalid config: %s',
    (invalid) => {
      const config = settings();
      if (invalid === 'url') config.set('AI_SERVER_BASE_URL', '');
      if (invalid === 'token') config.set('AI_SERVICE_TOKEN', '');
      if (invalid === 'protocol')
        config.set('AI_SERVER_BASE_URL', 'file:///tmp/ai');
      if (invalid === 'embedded-credentials')
        config.set('AI_SERVER_BASE_URL', 'http://user:password@localhost');
      expect(() => new HttpImageAnalysisProvider(config)).toThrow();
    },
  );
});

describe('provided v0.2 response contract', () => {
  it.each([
    'BOTH_SUCCESS',
    'GENERATION_FAILED',
    'MANIPULATION_FAILED',
    'BOTH_FAILED',
    'BOTH_INCONCLUSIVE',
    'NO_CLEAR_SIGNAL',
    'LOCALIZATION',
  ] as const)(
    'validates %s wire fields and projects through service',
    async (scenario) => {
      const file = makeFile(),
        ctx = context(file);
      const wire = await new MockImageAnalysisProvider(scenario).analyze(
        file,
        ctx,
      );
      expect(() => validateAiImageResponseV02(wire)).not.toThrow();
      expect(wire.analysisImage.inputSha256).toBe(
        createHash('sha256').update(file.buffer).digest('hex'),
      );
      expect(wire.requestedModels).toEqual(['generation', 'manipulation']);
      const result = await new ImageAnalysisService(
        { analyze: async () => wire },
        settings(),
      ).analyze(file, ctx);
      expect(result).toHaveProperty('format', 'v1');
    },
  );
  it.each([
    'raw-number',
    'uppercase-models',
    'object-reasons',
    'many-reasons',
    'many-limitations',
    'inconclusive-reasons',
    'metadata',
    'aggregate',
    'model-error',
    'no-models',
  ])('rejects incompatible wire data: %s', async (invalid) => {
    const file = makeFile();
    const wire = await new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
      file,
      context(file),
    );
    const value: any = structuredClone(wire);
    if (invalid === 'raw-number') value.generation.rawScore = 0.8;
    if (invalid === 'uppercase-models')
      value.requestedModels = ['GENERATION', 'MANIPULATION'];
    if (invalid === 'object-reasons')
      value.generation.reasons = [{ description: 'wrong' }];
    if (invalid === 'many-reasons')
      value.generation.reasons = Array(6).fill('reason');
    if (invalid === 'many-limitations')
      value.generation.limitations = Array(9).fill('limit');
    if (invalid === 'inconclusive-reasons') {
      value.generation.rawScore = { score: 0.01 };
      value.generation.decision = 'INCONCLUSIVE';
      value.generation.displayScore = null;
    }
    if (invalid === 'metadata') value.analysisImage.width = 8193;
    if (invalid === 'aggregate') value.status = 'PARTIAL_FAILED';
    if (invalid === 'model-error')
      value.generation.error = { code: 'wrong', retryable: true };
    if (invalid === 'no-models') {
      value.generation = null;
      value.manipulation = null;
      value.requestedModels = [];
    }
    expect(() => validateAiImageResponseV02(value)).toThrow();
  });
  it('rejects a response for different input bytes before storage', async () => {
    const file = makeFile(),
      ctx = context(file);
    const wire = await new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
      file,
      ctx,
    );
    wire.analysisImage.inputSha256 = '0'.repeat(64);
    await expect(
      new ImageAnalysisService(
        { analyze: async () => wire },
        settings(),
      ).analyze(file, ctx),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('allows integer rounding of map dimensions and rejects a distorted ratio', () => {
    const data = PNG.sync
      .write(new PNG({ width: 1024, height: 682 }), { colorType: 0 })
      .toString('base64');
    const map = {
      format: 'PNG_BASE64',
      kind: 'MANIPULATION_HEATMAP',
      mimeType: 'image/png',
      coordinateSpace: 'ANALYSIS_IMAGE',
      imageSize: { width: 3001, height: 2000 },
      mapSize: { width: 1024, height: 682 },
      data,
    };
    expect(() => validateLocalization(map)).not.toThrow();
    expect(() =>
      validateLocalization({
        ...map,
        imageSize: { width: 3001, height: 1000 },
      }),
    ).toThrow();
  });
});
