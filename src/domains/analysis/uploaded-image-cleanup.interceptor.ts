import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { finalize, Observable } from 'rxjs';

@Injectable()
export class UploadedImageCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      finalize(() => {
        const buffer = request.file?.buffer;
        if (Buffer.isBuffer(buffer)) buffer.fill(0);
      }),
    );
  }
}
