import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/http/api-error';
import type {
  AiImageAnalysisRequestV1,
  ImageAnalysisProvider,
} from './image-analysis.service';
import { validateImageAnalysisRequest } from './image-analysis-request.validator';
import { ImageAnalysisError } from './image-analysis.error';

/** BE→AI v0.2 transport. No automatic retry: a new attempt requires caller-owned context/budget. */
export class HttpImageAnalysisProvider implements ImageAnalysisProvider {
  private readonly endpoint: URL;
  private readonly token: string;
  constructor(private readonly config: ConfigService) {
    const base = config.get<string>('AI_SERVER_BASE_URL')?.trim();
    const token = config.get<string>('AI_SERVICE_TOKEN')?.trim();
    if (!base || !token || /\s/.test(token))
      throw new Error(
        'AI_SERVER_BASE_URL and AI_SERVICE_TOKEN are required for http AI provider',
      );
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new Error('Invalid AI_SERVER_BASE_URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid AI_SERVER_BASE_URL');
    this.endpoint = new URL('/internal/v1/image-analyses', url);
    this.token = token;
  }
  async analyze(
    file: Express.Multer.File,
    request?: AiImageAnalysisRequestV1,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    let phase: 'NETWORK' | 'INVALID_RESPONSE' = 'NETWORK';
    try {
      if (!request) throw new Error('Missing AI context');
      validateImageAnalysisRequest(request);
      if (!file.buffer.length)
        throw new ApiError(400, 'COMMON400', '이미지 파일이 필요합니다.');
      if (file.buffer.length > 10 * 1024 * 1024)
        throw new ApiError(
          413,
          'COMMON413',
          'AI 이미지 크기 제한을 초과했습니다.',
        );
      if (!['image/jpeg', 'image/png'].includes(file.mimetype))
        throw new ApiError(
          415,
          'COMMON415',
          'JPEG 또는 PNG 이미지가 필요합니다.',
        );
      const timeout = Number(
        this.config.get<string>('AI_REQUEST_TIMEOUT_MS') ?? 30000,
      );
      if (
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        timeout > 2147483647
      )
        throw new Error('Invalid AI timeout');
      const budget = Math.min(
        timeout,
        Date.parse(request.deadlineAt) - Date.now(),
      );
      if (budget <= 0) throw new ImageAnalysisError('TIMEOUT');
      timer = setTimeout(() => abort.abort(), budget);
      const combined = signal
        ? AbortSignal.any([signal, abort.signal])
        : abort.signal;
      combined.throwIfAborted();
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
        file.mimetype === 'image/png' ? 'analysis.png' : 'analysis.jpg',
      );
      for (const key of [
        'analysisId',
        'elementId',
        'sourceType',
        'models',
        'deadlineAt',
      ] as const)
        form.append(key, request[key]);
      const encoded = new Request(this.endpoint, {
        method: 'POST',
        body: form,
      });
      const body = await encoded.arrayBuffer();
      if (body.byteLength > 11 * 1024 * 1024)
        throw new ApiError(
          413,
          'COMMON413',
          'AI 요청 본문 크기 제한을 초과했습니다.',
        );
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': encoded.headers.get('content-type')!,
          Authorization: `Bearer ${this.token}`,
          'X-Request-ID': request.requestId,
        },
        body,
        signal: combined,
        redirect: 'error',
      });
      // Upstream bodies may contain internal IDs, traces, or secrets; never return/log them.
      if (response.status !== 200) {
        await response.body?.cancel();
        if ([400, 413, 415, 422].includes(response.status)) {
          const status = response.status === 422 ? 400 : response.status;
          throw new ApiError(
            status,
            `COMMON${status}`,
            'AI 서버가 이미지 요청을 처리할 수 없습니다.',
          );
        }
        throw new ImageAnalysisError('UPSTREAM');
      }
      phase = 'INVALID_RESPONSE';
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== 'object' ||
        !('contractVersion' in value) ||
        value.contractVersion !== '1.0'
      )
        throw new Error('Invalid AI envelope');
      return value;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ImageAnalysisError(
        abort.signal.aborted || signal?.aborted ? 'TIMEOUT' : phase,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
