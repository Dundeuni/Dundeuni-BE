import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisModelResult } from '@prisma/client';
import {
  GeminiSummaryClient,
  summaryInput,
  validateSummary,
  retryDelay,
  safeGeminiMessage,
} from '../src/domains/analysis/gemini-summary.client';
const model = (
  kind: 'GENERATION' | 'MANIPULATION',
  decision: AnalysisModelResult['decision'],
  status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
): AnalysisModelResult => ({
  id: 'private-id',
  analysisId: 'private-analysis',
  kind,
  decision,
  status,
  displayScore: status === 'FAILED' ? null : 80,
  reasons: [{ description: '확인 근거' }],
  limitations: [],
  modelName: 'private-model',
  modelVersion: '1',
  policyVersion: '1',
  errorCode: null,
  retryable: null,
});
const rows = [
  model('GENERATION', 'AI_GENERATED_SUSPECTED'),
  model('MANIPULATION', 'MANIPULATION_SUSPECTED'),
];
const input = summaryInput(rows);
const summary =
  'AI 생성과 관련된 의심 신호가 감지되었습니다. 이미지 변조와 관련된 의심 신호가 감지되었습니다. 출처와 원본을 확인하는 것이 좋습니다.';
const response = (value = summary, data = input) =>
  JSON.stringify({
    summary: value,
    generationDecision: data.generation?.decision ?? null,
    manipulationDecision: data.manipulation?.decision ?? null,
    overallDecision: data.overallResult.decision,
  });
describe('Gemini structured client and privacy', () => {
  let client: GeminiSummaryClient;
  let warning: jest.SpyInstance;
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    client = new GeminiSummaryClient(
      new ConfigService({
        GEMINI_API_KEY: 'test',
        GEMINI_MODEL: 'test-model',
        GEMINI_TIMEOUT_MS: '20',
      }),
    );
  });
  it('validates normal structured summary', async () => {
    jest.spyOn(client, 'request').mockResolvedValue(response());
    await expect(client.generate(input)).resolves.toEqual({
      summary,
      model: 'test-model',
    });
  });
  it.each([
    '',
    '{}',
    'not json',
    response(''),
    response('가'.repeat(601)),
    response('조작된 이미지입니다. 사기 확률은 80%입니다.'),
  ])('rejects invalid response %#', async (text) => {
    jest.spyOn(client, 'request').mockResolvedValue(text);
    await expect(client.generate(input)).rejects.toMatchObject({
      retryable: false,
    });
  });
  it('rejects decision echo mismatch and contradictory summary', () => {
    expect(() =>
      validateSummary(
        response(summary, summaryInput([model('GENERATION', 'INCONCLUSIVE')])),
        input,
      ),
    ).toThrow();
    expect(() =>
      validateSummary(
        response('AI 생성 신호는 없습니다. 이미지 변조 신호는 없습니다.'),
        input,
      ),
    ).toThrow();
  });
  it('times out a hung adapter and marks retryable', async () => {
    jest
      .spyOn(client, 'request')
      .mockImplementation(() => new Promise(() => {}));
    await expect(client.generate(input)).rejects.toMatchObject({
      code: 'GEMINI_TIMEOUT',
      retryable: true,
    });
  });
  it.each([
    [401, false],
    [403, false],
    [429, false],
    [503, true],
    [400, false],
  ])('classifies HTTP %s', async (status, retryable) => {
    jest.spyOn(client, 'request').mockRejectedValue({ status });
    await expect(client.generate(input)).rejects.toMatchObject({ retryable });
  });
  it.each([429, 503, 404, 401])(
    'logs safe HTTP status %s without SDK secrets or contents',
    async (status) => {
      jest.spyOn(client, 'request').mockRejectedValue({
        status,
        message: 'secret-key user-input raw-response',
        apiKey: 'secret-key',
        url: 'https://private/?key=secret-key',
      });
      await expect(client.generate(input)).rejects.toBeInstanceOf(Error);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`status=${status}`),
      );
      const logged = JSON.stringify(warning.mock.calls);
      for (const privateValue of [
        'secret-key',
        'user-input',
        'raw-response',
        'https://private',
      ])
        expect(logged).not.toContain(privateValue);
    },
  );
  it('never logs untrusted status strings', async () => {
    jest
      .spyOn(client, 'request')
      .mockRejectedValue({ status: '503 secret-key', message: 'private-body' });
    await expect(client.generate(input)).rejects.toBeInstanceOf(Error);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'status=unknown code=GEMINI_REQUEST_FAILED retryable=false',
      ),
    );
  });
  it('429 retries only under the explicit cooldown policy', async () => {
    const client = new GeminiSummaryClient(
      new ConfigService({
        GEMINI_API_KEY: 'test',
        GEMINI_MODEL: 'gemini-test',
        GEMINI_SUMMARY_RATE_LIMIT_POLICY: 'retry',
      }),
    );
    jest.spyOn(client, 'request').mockRejectedValue({ status: 429 });
    await expect(client.generate(input)).rejects.toMatchObject({
      code: 'GEMINI_RATE_LIMIT',
      retryable: true,
    });
  });
  it('uses bounded exponential jitter and separate rate-limit delay', () => {
    const config = new ConfigService({
      GEMINI_SUMMARY_RETRY_MS: '100',
      GEMINI_SUMMARY_RETRY_MAX_MS: '1000',
      GEMINI_SUMMARY_RATE_LIMIT_RETRY_MS: '800',
    });
    expect(retryDelay(config, 1, false, () => 0)).toBe(50);
    expect(retryDelay(config, 2, false, () => 0.5)).toBe(150);
    expect(retryDelay(config, 10, false, () => 1)).toBe(1000);
    expect(retryDelay(config, 1, true, () => 0)).toBe(400);
  });
  it('logs allowlisted error reason, configured model and elapsed time without upstream message', async () => {
    jest.spyOn(client, 'request').mockRejectedValue({
      status: 503,
      message: 'high demand secret-key personal-input',
    });
    await expect(client.generate(input)).rejects.toBeInstanceOf(Error);
    expect(warning).toHaveBeenCalledWith(
      expect.stringMatching(
        /status=503.*timeoutMs=20 durationMs=\d+ reason=model_overloaded/,
      ),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain('secret-key');
    expect(safeGeminiMessage({ message: 'unknown confidential detail' })).toBe(
      'upstream_message_omitted',
    );
  });
  it('missing settings are permanent errors', async () => {
    const emptyConfig = new ConfigService();
    jest.spyOn(emptyConfig, 'get').mockReturnValue(undefined);
    await expect(
      new GeminiSummaryClient(emptyConfig).generate(input),
    ).rejects.toMatchObject({ code: 'GEMINI_CONFIG', retryable: false });
  });
  it('shutdown cancels without waiting for timeout', async () => {
    jest
      .spyOn(client, 'request')
      .mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const promise = client.generate(input, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: 'SUMMARY_SHUTDOWN' });
  });
  it.each([
    [rows, 'GENERATION_OR_MANIPULATION_SUSPECTED'],
    [
      [model('GENERATION', null, 'FAILED'), rows[1]],
      'GENERATION_OR_MANIPULATION_SUSPECTED',
    ],
    [
      [rows[0], model('MANIPULATION', null, 'FAILED')],
      'GENERATION_OR_MANIPULATION_SUSPECTED',
    ],
    [
      [
        model('GENERATION', null, 'FAILED'),
        model('MANIPULATION', null, 'FAILED'),
      ],
      'INCONCLUSIVE',
    ],
    [[model('GENERATION', 'INCONCLUSIVE')], 'INCONCLUSIVE'],
    [
      [
        model('GENERATION', 'NO_CLEAR_GENERATION_SIGNAL'),
        model('MANIPULATION', 'NO_CLEAR_MANIPULATION_SIGNAL'),
      ],
      'NO_CLEAR_SIGNAL',
    ],
  ])('reuses representative policy %#', (values, expected) => {
    expect(
      summaryInput(values as AnalysisModelResult[]).overallResult.decision,
    ).toBe(expected);
  });
  it('excludes all free text and identifiers from the Gemini payload', () => {
    const dirty = {
      ...rows[0],
      reasons: [
        {
          description:
            'test@example.com https://secret/path Bearer secret 010-1234-5678 internal-id sk-private API_KEY=private',
        },
      ],
      limitations: ['internal-id sk-private API_KEY=private'],
      userId: 'private-user',
      rawScore: 1,
      localization: 'secret-heatmap',
      file: 'original.png',
    };
    const text = JSON.stringify(summaryInput([dirty]));
    for (const forbidden of [
      'private-id',
      'private-user',
      'private-analysis',
      'secret',
      'original.png',
      'rawScore',
      'localization',
      'test@example.com',
      '010-1234',
      'internal-id',
      'sk-private',
      'API_KEY',
      'reasons',
      'limitations',
    ])
      expect(text).not.toContain(forbidden);
  });
  it.each([
    'AI로 만들어졌을 가능성이 있습니다. 이미지 조작의 징후가 발견되었습니다.',
    'AI 생성의 흔적이 보입니다. 이미지 합성 가능성이 높습니다.',
    'AI 생성 의심 신호가 있습니다. 이미지 변조 의심 신호가 있습니다. 이것만으로 진위를 단정할 수 없습니다.',
  ])('accepts synonymous suspicion %#', (text) => {
    expect(validateSummary(response(text), input)).toBe(text);
  });
  it('accepts synonymous no-signal and uncertainty separately', () => {
    const data = summaryInput([
      model('GENERATION', 'INCONCLUSIVE'),
      model('MANIPULATION', 'NO_CLEAR_MANIPULATION_SIGNAL'),
    ]);
    const text =
      '인공지능으로 만들어졌는지는 불분명합니다. 이미지 조작의 흔적은 발견되지 않았습니다.';
    expect(validateSummary(response(text, data), data)).toBe(text);
  });
  it('does not confuse inconclusive with absence of evidence', () => {
    const data = summaryInput([
      model('GENERATION', 'INCONCLUSIVE'),
      model('MANIPULATION', 'INCONCLUSIVE'),
    ]);
    const text =
      'AI 생성 여부는 명확하지 않습니다. 이미지 변조 여부는 확실하게 판단할 수 없습니다.';
    expect(validateSummary(response(text, data), data)).toBe(text);
  });
  it('accepts failed vs unrequested explanations but does not call failure success', () => {
    const data = summaryInput([model('GENERATION', null, 'FAILED')]);
    const text =
      'AI 생성 분석은 오류로 완료되지 않았습니다. 이미지 변조 분석은 요청되지 않았습니다.';
    expect(validateSummary(response(text, data), data)).toBe(text);
    expect(() =>
      validateSummary(
        response(
          'AI 생성의 뚜렷한 신호는 없습니다. 이미지 변조는 분석하지 않았습니다.',
          data,
        ),
        data,
      ),
    ).toThrow(
      expect.objectContaining({ diagnostic: 'generation:OPPOSITE_DECISION' }),
    );
  });
  it('checks contradictory later statements and reports safe model/rule only', async () => {
    const text =
      'AI 생성 신호가 의심됩니다. 이미지 변조 신호가 의심됩니다. AI 생성 신호는 없습니다.';
    jest.spyOn(client, 'request').mockResolvedValue(response(text));
    await expect(client.generate(input)).rejects.toMatchObject({
      code: 'SUMMARY_CONTRADICTION',
      diagnostic: 'generation:OPPOSITE_DECISION',
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('diagnostic=generation:OPPOSITE_DECISION'),
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(text);
  });
  it('reports missing explanation without logging text', () => {
    expect(() =>
      validateSummary(
        response('이미지를 확인하는 것이 좋습니다. 출처와 원본을 확인하세요.'),
        input,
      ),
    ).toThrow(
      expect.objectContaining({
        diagnostic: 'generation:MISSING_MODEL_EXPLANATION',
      }),
    );
  });
  it('allows failure/inconclusive/no-evidence summaries with accurate decisions', () => {
    const data = summaryInput([
      model('GENERATION', 'INCONCLUSIVE'),
      model('MANIPULATION', null, 'FAILED'),
    ]);
    expect(
      validateSummary(
        response(
          'AI 생성 여부는 판단하기 어렵습니다. 이미지 변조 분석은 실패하여 판단할 수 없습니다.',
          data,
        ),
        data,
      ),
    ).toContain('실패');
  });
});

import { AnalysisSummaryWorker } from '../src/domains/analysis/analysis-summary.worker';
import { AnalysisSummaryRepository } from '../src/domains/analysis/analysis-summary.repository';
describe('worker slot and shutdown management', () => {
  it('waits for sibling slots when one fails', async () => {
    const worker = new AnalysisSummaryWorker(
      {
        reconcile: jest.fn().mockResolvedValue(undefined),
      } as unknown as AnalysisSummaryRepository,
      {} as GeminiSummaryClient,
      new ConfigService({ GEMINI_SUMMARY_CONCURRENCY: '2' }),
    );
    let release!: () => void;
    jest
      .spyOn(worker, 'processOne')
      .mockRejectedValueOnce(new Error('DB'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    let finished = false;
    const promise = worker.tick().catch(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    await promise;
    expect(finished).toBe(true);
  });
  it('aborts an in-flight request and reschedules it on shutdown', async () => {
    const jobs = {
      enabled: () => true,
      reconcile: jest.fn().mockResolvedValue(undefined),
      claim: jest.fn().mockResolvedValue({ analysisId: 'id', attempts: 1 }),
      models: jest.fn().mockResolvedValue({
        imageResultStatus: 'COMPLETED',
        modelResults: rows,
        expiresAt: new Date(Date.now() + 60000),
      }),
      finish: jest.fn().mockResolvedValue(true),
    };
    const client = new GeminiSummaryClient(
      new ConfigService({ GEMINI_API_KEY: 'test', GEMINI_MODEL: 'test' }),
    );
    jest
      .spyOn(client, 'request')
      .mockImplementation(() => new Promise(() => {}));
    const worker = new AnalysisSummaryWorker(
      jobs as unknown as AnalysisSummaryRepository,
      client,
      new ConfigService(),
    );
    worker.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));
    await worker.onModuleDestroy();
    expect(jobs.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 'SUMMARY_SHUTDOWN', retryable: true }),
    );
  });
});
