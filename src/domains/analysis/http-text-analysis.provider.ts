import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/http/api-error';
import { TextAnalysisError } from './text-analysis.error';
import { TextAnalysisInput, TextAnalysisProvider } from './text-analysis.input';

export class HttpTextAnalysisProvider implements TextAnalysisProvider {
  private readonly base: URL;
  private readonly token: string;
  constructor(config: ConfigService) {
    const base = config.get<string>('AI_SERVICE_BASE_URL')?.trim();
    const token = (
      config.get<string>('TEXT_AI_SERVICE_TOKEN') ??
      config.get<string>('AI_SERVICE_TOKEN')
    )?.trim();
    if (!base || !token || /\s/.test(token))
      throw new Error(
        'TEXT HTTP requires AI_SERVICE_BASE_URL and AI_SERVICE_TOKEN',
      );
    const url = new URL(base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid AI_SERVICE_BASE_URL');
    this.base = url;
    this.token = token;
  }
  analyze(input: TextAnalysisInput, signal: AbortSignal): Promise<unknown> {
    // No schemaVersion, sourceType, userId, models or deadlineAt in the deployed JSON input.
    return this.send(
      '/internal/v1/text-analyses',
      JSON.stringify({
        text: input.text,
        analysisId: input.analysisId,
        elementId: input.elementId,
      }),
      { 'Content-Type': 'application/json' },
      signal,
    );
  }
  analyzeImage(
    file: Express.Multer.File,
    context: {
      analysisId: string;
      elementId: string;
      sourceType: 'IMAGE' | 'SCREEN_CROP';
    },
    signal: AbortSignal,
  ): Promise<unknown> {
    if (
      !['image/png', 'image/jpeg'].includes(file.mimetype) ||
      !file.buffer.length ||
      file.buffer.length > 10 * 1024 * 1024
    )
      throw new ApiError(
        400,
        'COMMON400',
        'OCR에는 10MiB 이하 JPEG/PNG 이미지가 필요합니다.',
      );
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      file.mimetype === 'image/png' ? 'capture.png' : 'capture.jpg',
    );
    form.append('analysisId', context.analysisId);
    form.append('elementId', context.elementId);
    form.append('sourceType', context.sourceType);
    return this.send('/internal/v1/text-analyses/image', form, {}, signal);
  }
  private async send(
    path: string,
    body: BodyInit,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    let phase: 'NETWORK' | 'INVALID_RESPONSE' = 'NETWORK';
    try {
      signal.throwIfAborted();
      const response = await fetch(new URL(path, this.base), {
        method: 'POST',
        body,
        headers: { ...headers, Authorization: `Bearer ${this.token}` },
        signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new TextAnalysisError('UPSTREAM', response.status);
      }
      phase = 'INVALID_RESPONSE';
      // Bound an untrusted response, including its raw text/OCR echo. Never persist or log it.
      const reader = response.body?.getReader();
      if (!reader) throw new TextAnalysisError(phase);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 512 * 1024) {
            await reader.cancel();
            throw new TextAnalysisError(phase);
          }
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } finally {
        reader.releaseLock();
        chunks.forEach((chunk) => chunk.fill(0));
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new TextAnalysisError(signal.aborted ? 'TIMEOUT' : phase);
    }
  }
}

export const TEXT_ANALYSIS_PROVIDER = Symbol('TEXT_ANALYSIS_PROVIDER');
export function selectTextAnalysisProvider(
  config: ConfigService,
): TextAnalysisProvider {
  const mode = config.get<string>('TEXT_AI_PROVIDER') ?? 'disabled';
  if (mode === 'http') return new HttpTextAnalysisProvider(config);
  if (mode !== 'disabled')
    throw new Error('TEXT_AI_PROVIDER must be disabled or http');
  return {
    analyze: async () => {
      throw new TextAnalysisError('UPSTREAM');
    },
  };
}
