import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

/** Enforce the configured limit before Multer buffers the entire file. */
@Injectable()
export class BoundedPhotoUploadInterceptor implements NestInterceptor {
  private readonly upload: NestInterceptor;
  constructor(config: ConfigService) {
    const fileSize = Number(config.get<string>('ANALYSIS_MAX_FILE_BYTES'));
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0)
      throw new Error('ANALYSIS_MAX_FILE_BYTES must be a positive integer');
    this.upload = new (FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize, files: 1, fields: 0, parts: 1 },
    }))();
  }
  intercept(context: ExecutionContext, next: CallHandler) {
    return this.upload.intercept(context, next);
  }
}
