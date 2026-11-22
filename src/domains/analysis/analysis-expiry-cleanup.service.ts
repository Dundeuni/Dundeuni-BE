import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisExpiryRepository } from './analysis-expiry.repository';

@Injectable()
export class AnalysisExpiryCleanupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AnalysisExpiryCleanupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: AnalysisExpiryRepository,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const interval = Number(
      this.config.get<string>('ANALYSIS_CLEANUP_INTERVAL_MS') ?? 60000,
    );
    if (
      !Number.isSafeInteger(interval) ||
      interval < 1000 ||
      interval > 2147483647
    )
      throw new Error(
        'ANALYSIS_CLEANUP_INTERVAL_MS must be an integer between 1000 and 2147483647',
      );
    this.timer = setInterval(() => void this.runOnce(), interval);
    this.timer.unref();
    void this.runOnce();
  }

  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = Promise.resolve()
      .then(() => this.repository.deleteExpiredBatch(new Date()))
      .then(() => undefined)
      .catch(() => {
        // Database errors may contain row data or connection details. Never log their bodies.
        this.logger.warn('ANALYSIS_EXPIRY_CLEANUP_FAILED');
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
