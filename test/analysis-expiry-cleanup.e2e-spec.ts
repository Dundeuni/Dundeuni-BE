import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisExpiryCleanupService } from '../src/domains/analysis/analysis-expiry-cleanup.service';
import { AnalysisExpiryRepository } from '../src/domains/analysis/analysis-expiry.repository';
import {
  analysisExpiresAt,
  MAX_ANALYSIS_RETENTION_SECONDS,
} from '../src/domains/analysis/analysis-retention.policy';

describe('analysis retention maximum', () => {
  const now = new Date('2026-11-22T00:00:00Z');
  it.each([
    [1, 1],
    [86400, 86400],
    [2592000, 2592000],
    [2592001, 2592000],
    [Number.MAX_SAFE_INTEGER, 2592000],
  ])(
    'caps configured %s seconds at %s seconds without overflow',
    (configured, expected) => {
      expect(analysisExpiresAt(configured, now).getTime() - now.getTime()).toBe(
        expected * 1000,
      );
    },
  );
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid retention %s',
    (seconds) => {
      expect(() => analysisExpiresAt(seconds, now)).toThrow();
    },
  );
  it('does not accept an invalid clock value', () => {
    expect(() =>
      analysisExpiresAt(MAX_ANALYSIS_RETENTION_SECONDS, new Date(NaN)),
    ).toThrow();
  });
});

describe('expired analysis background cleanup lifecycle', () => {
  let service: AnalysisExpiryCleanupService;
  const repository = { deleteExpiredBatch: jest.fn() };
  let warnings: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    repository.deleteExpiredBatch.mockReset().mockResolvedValue(0);
    warnings = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    service = new AnalysisExpiryCleanupService(
      repository as unknown as AnalysisExpiryRepository,
      new ConfigService({ ANALYSIS_CLEANUP_INTERVAL_MS: '1000' }),
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    warnings.mockRestore();
    jest.useRealTimers();
  });
  it('runs at application startup and on each interval, then stops cleanly', async () => {
    service.onApplicationBootstrap();
    await service.runOnce();
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(1);
    expect(repository.deleteExpiredBatch).toHaveBeenCalledWith(
      expect.any(Date),
    );
    jest.advanceTimersByTime(1000);
    await service.runOnce();
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    jest.advanceTimersByTime(10000);
    await service.runOnce();
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(2);
  });
  it('defaults to one minute between batches', async () => {
    service = new AnalysisExpiryCleanupService(
      repository as unknown as AnalysisExpiryRepository,
      new ConfigService(),
    );
    service.onApplicationBootstrap();
    await service.runOnce();
    jest.advanceTimersByTime(59999);
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await service.runOnce();
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(2);
  });
  it('does not overlap a slow batch and waits for it during shutdown', async () => {
    let resolve!: (count: number) => void;
    repository.deleteExpiredBatch.mockImplementation(
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    service.onApplicationBootstrap();
    await Promise.resolve();
    jest.advanceTimersByTime(5000);
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = service.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve(0);
    await closing;
    expect(closed).toBe(true);
    jest.advanceTimersByTime(10000);
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(1);
  });
  it('retries after a DB error on the next interval without logging private errors', async () => {
    repository.deleteExpiredBatch
      .mockRejectedValueOnce(new Error('private DB credentials'))
      .mockResolvedValue(1);
    service.onApplicationBootstrap();
    await service.runOnce();
    expect(warnings).toHaveBeenCalledWith('ANALYSIS_EXPIRY_CLEANUP_FAILED');
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('private');
    jest.advanceTimersByTime(1000);
    await service.runOnce();
    expect(repository.deleteExpiredBatch).toHaveBeenCalledTimes(2);
  });
  it.each(['0', '-1', '999', '1.5', 'bad', '2147483648'])(
    'rejects invalid timer configuration %s',
    (value) => {
      service = new AnalysisExpiryCleanupService(
        repository as unknown as AnalysisExpiryRepository,
        new ConfigService({ ANALYSIS_CLEANUP_INTERVAL_MS: value }),
      );
      expect(() => service.onApplicationBootstrap()).toThrow(
        'ANALYSIS_CLEANUP_INTERVAL_MS',
      );
      expect(jest.getTimerCount()).toBe(0);
    },
  );
});
