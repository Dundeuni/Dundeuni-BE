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
