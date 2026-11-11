import { textWire } from './fixtures/text-risk';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { HttpTextAnalysisProvider } from '../src/domains/analysis/http-text-analysis.provider';
import { TextAiWorkflowService } from '../src/domains/analysis/text-ai-workflow.service';

// Exercise real transport error conversion and workflow logging without network/DB calls.
describe('TEXT AI failure diagnostics', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['unauthorized', 401, 'UPSTREAM'],
    ['offline tunnel', 404, 'UPSTREAM'],
    ['server failure', 503, 'UPSTREAM'],
    ['invalid JSON', 200, 'INVALID_RESPONSE'],
    ['invalid contract', 200, 'INVALID_RESPONSE'],
    ['network', null, 'NETWORK'],
    ['timeout', null, 'TIMEOUT'],
  ] as const)(
    'logs safe diagnostic fields for %s',
    async (scenario, status, failureKind) => {
      const config = new ConfigService({
        AI_SERVICE_BASE_URL: 'https://test.invalid',
        TEXT_AI_SERVICE_TOKEN: 'private-token',
        AI_REQUEST_TIMEOUT_MS: scenario === 'timeout' ? '10' : '1000',
      });
      const analysisId = randomUUID();
      const repository = {
        createText: jest.fn().mockResolvedValue({ id: analysisId }),
        analyzing: jest.fn().mockResolvedValue(undefined),
        fail: jest.fn().mockResolvedValue(undefined),
      };
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const transport = jest.spyOn(globalThis, 'fetch');
      if (scenario === 'network')
        transport.mockRejectedValue(
          new Error('private network details private-token'),
        );
      else if (scenario === 'timeout')
        transport.mockImplementation(() => new Promise(() => {}));
      else
        transport.mockResolvedValue(
          new Response(
            scenario === 'invalid contract' ? '{}' : 'private upstream body',
            {
              status: status!,
              headers:
                scenario === 'offline tunnel'
                  ? { 'ngrok-error-code': 'ERR_NGROK_3200' }
                  : {},
            },
          ),
        );
      const service = new TextAiWorkflowService(
        repository as unknown as AnalysisRepository,
        new HttpTextAnalysisProvider(config),
        config,
      );
      await expect(
        service.create('private-user', 'private original text'),
      ).rejects.toMatchObject({
        response: { code: 'ANALYSIS503', result: null },
      });
      expect(log.mock.calls.map(([value]) => value.event)).toEqual([
        'TEXT_AI_CALL_STARTED',
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith({
        event: 'TEXT_AI_CALL_FAILED',
        startedAt: expect.any(String),
        upstreamHost: 'test.invalid',
        upstreamPath: '/internal/v1/text-analyses',
        ngrokErrorCode: scenario === 'offline tunnel' ? 'ERR_NGROK_3200' : null,
        analysisId,
        sourceType: 'TEXT',
        endpoint: '/internal/v1/text-analyses',
        failureKind,
        upstreamStatus: status,
        durationMs: expect.any(Number),
      });
      expect(repository.fail).toHaveBeenCalledWith(analysisId, 'ANALYSIS503');
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /private|Authorization|Bearer/,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
});

describe('TEXT AI completion logs', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['TEXT', 'SCREEN_CROP'] as const)(
    'logs completion only after %s results are saved',
    async (sourceType) => {
      const analysisId = randomUUID();
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});
      let finishSave!: () => void;
      const saved = {
        id: analysisId,
        type: 'TEXT',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: new Date(),
      };
      const repository = {
        createText: jest.fn().mockResolvedValue({ id: analysisId }),
        analyzing: jest.fn().mockResolvedValue(undefined),
        completeText: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              finishSave = () => resolve(saved);
            }),
        ),
        fail: jest.fn(),
      };
      const respond = async (...args: any[]) => {
        const context = sourceType === 'TEXT' ? args[0] : args[1];
        return textWire(context.analysisId, context.elementId, sourceType);
      };
      const provider = {
        analyze: jest.fn(respond),
        analyzeImage: jest.fn(respond),
      };
      const service = new TextAiWorkflowService(
        repository as unknown as AnalysisRepository,
        provider,
        new ConfigService({
          AI_SERVICE_BASE_URL: 'https://test.invalid',
          AI_REQUEST_TIMEOUT_MS: '1000',
        }),
      );
      const request =
        sourceType === 'TEXT'
          ? service.create('private-user', 'private original')
          : service.createCapture('private-user', {
              buffer: Buffer.from('private image'),
              mimetype: 'image/png',
            } as Express.Multer.File);
      for (let i = 0; i < 20 && !finishSave; i++) await Promise.resolve();
      expect(repository.completeText).toHaveBeenCalled();
      expect(log.mock.calls.map(([value]) => value.event)).toEqual([
        'TEXT_AI_CALL_STARTED',
      ]);
      finishSave();
      await expect(request).resolves.toMatchObject({ code: 'ANALYSIS202' });
      expect(log.mock.calls.map(([value]) => value.event)).toEqual([
        'TEXT_AI_CALL_STARTED',
        'TEXT_AI_CALL_SUCCEEDED',
      ]);
      expect(log.mock.calls[1][0]).toMatchObject({
        analysisId,
        sourceType,
        upstreamStatus: 200,
        status: 'COMPLETED',
        durationMs: expect.any(Number),
      });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /private|Authorization|Bearer/,
      );
    },
  );
});
