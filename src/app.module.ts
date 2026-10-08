import { AnalysisModule } from './domains/analysis/analysis.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './common/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    HealthModule,
    AnalysisModule,
  ],
})
export class AppModule {}
