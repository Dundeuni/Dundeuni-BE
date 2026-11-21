import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisSummaryRepository } from './analysis-summary.repository';
import {
  GeminiSummaryClient,
  positiveSetting,
  summaryInput,
  SummaryError,
  retryDelay,
} from './gemini-summary.client';

@Injectable()
export class AnalysisSummaryWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AnalysisSummaryWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly shutdown = new AbortController();
  constructor(
    private readonly jobs: AnalysisSummaryRepository,
    private readonly client: GeminiSummaryClient,
    private readonly config: ConfigService,
  ) {}
  onApplicationBootstrap() {
    if (!this.jobs.enabled()) return;
    const poll = positiveSetting(this.config, 'GEMINI_SUMMARY_POLL_MS', 1000);
    positiveSetting(this.config, 'GEMINI_SUMMARY_CONCURRENCY', 1, 8);
    positiveSetting(this.config, 'GEMINI_SUMMARY_MAX_ATTEMPTS', 3, 10);
    positiveSetting(this.config, 'GEMINI_SUMMARY_RETRY_MS', 5000);
    positiveSetting(this.config, 'GEMINI_TIMEOUT_MS', 15000);
    retryDelay(this.config, 1);
    retryDelay(this.config, 1, true);
    const ratePolicy =
      this.config.get('GEMINI_SUMMARY_RATE_LIMIT_POLICY') ?? 'fail';
    if (!['fail', 'retry'].includes(ratePolicy))
      throw new SummaryError('SUMMARY_CONFIG');
    const run = () => {
      if (this.running || this.shutdown.signal.aborted) return;
      this.running = this.tick()
        .catch(() => this.logger.warn('SUMMARY_WORKER_DB_ERROR'))
        .finally(() => {
          this.running = undefined;
        });
    };
    this.timer = setInterval(run, poll);
    this.timer.unref();
    run();
  }
  async tick() {
    await this.jobs.reconcile();
    const count = positiveSetting(
      this.config,
      'GEMINI_SUMMARY_CONCURRENCY',
      1,
      8,
    );
    // Wait for every slot even when one DB operation fails; otherwise a new tick
    // could exceed the concurrency limit while sibling requests are still running.
    const results = await Promise.allSettled(
      Array.from({ length: count }, () => this.processOne()),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new SummaryError('SUMMARY_WORKER_DB_ERROR');
  }
  async processOne() {
    if (this.shutdown.signal.aborted) return;
    const job = await this.jobs.claim();
    if (!job) return;
    try {
      if (
        job.attempts >
        positiveSetting(this.config, 'GEMINI_SUMMARY_MAX_ATTEMPTS', 3, 10)
      )
        throw new SummaryError('SUMMARY_ATTEMPTS_EXHAUSTED');
      const analysis = await this.jobs.models(job.analysisId);
      if (!analysis?.imageResultStatus || !analysis.modelResults.length)
        throw new SummaryError('SUMMARY_MODELS_NOT_READY');
      if (analysis.expiresAt <= new Date())
        throw new SummaryError('SUMMARY_EXPIRED');
      const result = await this.client.generate(
        summaryInput(analysis.modelResults),
        this.shutdown.signal,
      );
      await this.jobs.finish(job, result);
    } catch (error) {
      // Store codes only. SDK errors may contain request URLs or credentials.
      await this.jobs.finish(
        job,
        error instanceof SummaryError
          ? error
          : new SummaryError('SUMMARY_INTERNAL_ERROR', true),
      );
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.shutdown.abort();
    await this.running;
    // Interrupted attempts are rescheduled; process crashes recover by lease expiry.
  }
}
