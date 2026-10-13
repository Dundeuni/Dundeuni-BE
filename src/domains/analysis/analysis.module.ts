import { UploadedImageCleanupInterceptor } from './uploaded-image-cleanup.interceptor';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AccessTokenGuard } from '../../common/auth/access-token.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalysisController } from './analysis.controller';
import { AnalysisRepository } from './analysis.repository';
import { selectImageAnalysisProvider } from './mock-image-analysis.provider';
import { AnalysisService } from './analysis.service';
import { AnalysisUsageService } from './analysis-usage.service';
import {
  IMAGE_ANALYSIS_PROVIDER,
  ImageAnalysisService,
} from './image-analysis.service';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const fileSize = Number(config.get<string>('ANALYSIS_MAX_FILE_BYTES'));
        if (!Number.isSafeInteger(fileSize) || fileSize <= 0)
          throw new Error('ANALYSIS_MAX_FILE_BYTES must be a positive integer');
        return {
          storage: memoryStorage(),
          limits: { fileSize, files: 1, fields: 1, parts: 2, fieldSize: 64 },
        };
      },
    }),
  ],
  controllers: [AnalysisController],
  providers: [
    UploadedImageCleanupInterceptor,
    PrismaService,
    AccessTokenGuard,
    AnalysisService,
    AnalysisRepository,
    AnalysisUsageService,
    ImageAnalysisService,
    {
      provide: IMAGE_ANALYSIS_PROVIDER,
      inject: [ConfigService],
      useFactory: selectImageAnalysisProvider,
    },
  ],
})
export class AnalysisModule {}
