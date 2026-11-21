import { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { UploadedImageCleanupInterceptor } from '../src/domains/analysis/uploaded-image-cleanup.interceptor';

describe('uploaded image cleanup', () => {
  const intercept = (file: unknown, fails = false) => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ file }) }),
    } as unknown as ExecutionContext;
    return new UploadedImageCleanupInterceptor().intercept(context, {
      handle: () =>
        fails ? throwError(() => new Error('original failure')) : of('ok'),
    });
  };

  it.each([undefined, {}, { buffer: undefined }, { buffer: 'invalid' }])(
    'preserves the original error when no memory buffer exists: %p',
    async (file) => {
      await expect(lastValueFrom(intercept(file, true))).rejects.toThrow(
        'original failure',
      );
      await expect(lastValueFrom(intercept(file))).resolves.toBe('ok');
    },
  );

  it.each([false, true])(
    'clears an uploaded buffer even on failure: %s',
    async (fails) => {
      const buffer = Buffer.from('uploaded image');
      if (fails) {
        await expect(
          lastValueFrom(intercept({ buffer }, true)),
        ).rejects.toThrow('original failure');
      } else {
        await expect(lastValueFrom(intercept({ buffer }))).resolves.toBe('ok');
      }
      expect(buffer.equals(Buffer.alloc(buffer.length))).toBe(true);
    },
  );
});
