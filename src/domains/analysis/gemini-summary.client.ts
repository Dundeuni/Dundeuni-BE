import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import {
  exactRecord,
  parseSummaryDetail,
  SummaryDetail,
  SummaryInput,
  summaryOptions,
  summaryResponseSchema,
} from './image-summary-content';
export { summaryInput } from './image-summary-content';

export class SummaryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(code);
  }
}
export function positiveSetting(
  config: ConfigService,
  key: string,
  fallback: number,
  maximum = 3600000,
) {
  const value = Number(config.get(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new SummaryError('SUMMARY_CONFIG');
  return value;
}
/** Never print arbitrary upstream messages: they may echo credentials or input.
 * Match known service messages and log only a fixed diagnostic label. */
export function safeModelLabel(model: string): string {
  return /^(?:models\/)?gemini-[a-zA-Z0-9._-]{1,100}$/.test(model)
    ? model
    : 'configured_model_redacted';
}
export function safeGeminiMessage(error: unknown): string {
  const message =
    typeof (error as { message?: unknown } | null)?.message === 'string'
      ? (error as { message: string }).message.toLowerCase()
      : '';
  if (/high demand|overload/.test(message)) return 'model_overloaded';
  if (/quota|resource.exhausted|rate.limit/.test(message))
    return 'quota_or_rate_limit';
  if (/no longer available|not found|not supported/.test(message))
    return 'model_unavailable';
  if (/deadline|timed out|timeout/.test(message)) return 'upstream_timeout';
  return 'upstream_message_omitted';
}
export function retryDelay(
  config: ConfigService,
  attempt: number,
  rateLimited = false,
  random = Math.random,
): number {
  const base = positiveSetting(
    config,
    rateLimited
      ? 'GEMINI_SUMMARY_RATE_LIMIT_RETRY_MS'
      : 'GEMINI_SUMMARY_RETRY_MS',
    rateLimited ? 60000 : 5000,
  );
  const cap = positiveSetting(config, 'GEMINI_SUMMARY_RETRY_MAX_MS', 300000);
  const exponential = Math.min(
    cap,
    base * 2 ** Math.min(Math.max(attempt - 1, 0), 8),
  );
  // Equal jitter: bounded [50%,100%] delay avoids synchronized retry storms.
  return Math.ceil(exponential * (0.5 + random() * 0.5));
}
export const SUMMARY_INSTRUCTION = `고령층이 이해하기 쉬운 화면 설명을 작성합니다.
JSON 스키마가 허용한 문구만 고릅니다. summary는 종합 판정과 두 모델 결과를 담은 문구를 고릅니다.
detailedReasons는 각 evidenceCode에 맞는 type, title, description을 한 항목씩 반환합니다.
근거가 없으면 빈 배열을 반환합니다. 같은 항목의 title과 description을 짝지어 반환합니다.
서로 다른 대응 수칙 세 가지를 관련성이 높은 순서로 담습니다. reassurance는 안심 조언을 고릅니다.
응답의 세 판정 필드는 입력에서 그대로 복사합니다. 점수, 개인정보, 모델 정보나 새로운 사실을 쓰지 않습니다.`;

export function validateSummary(
  text: string,
  input: SummaryInput,
): SummaryDetail & { summary: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SummaryError('SUMMARY_INVALID_RESPONSE');
  }
  if (
    !exactRecord(data, [
      'summary',
      'detailedReasons',
      'actionGuides',
      'reassurance',
      'generationDecision',
      'manipulationDecision',
      'overallDecision',
    ])
  )
    throw new SummaryError('SUMMARY_INVALID_RESPONSE');

  const { summary, detailedReasons, actionGuides, reassurance } = data;
  if (
    data.generationDecision !== (input.generation?.decision ?? null) ||
    data.manipulationDecision !== (input.manipulation?.decision ?? null) ||
    data.overallDecision !== input.overallResult.decision
  )
    throw new SummaryError('SUMMARY_CONTRADICTION');

  const options = summaryOptions(input);
  const detail = parseSummaryDetail(
    { detailedReasons, actionGuides, reassurance },
    options.detailedReasons,
  );
  if (
    typeof summary !== 'string' ||
    !options.summaries.includes(summary) ||
    !detail ||
    detail.detailedReasons.length !== options.detailedReasons.length
  )
    throw new SummaryError('SUMMARY_INVALID_RESPONSE');

  return { summary, ...detail };
}
@Injectable()
export class GeminiSummaryClient {
  private readonly logger = new Logger(GeminiSummaryClient.name);
  constructor(private readonly config: ConfigService) {}
  // Public adapter seam for unit tests; the worker can also replace this entire DI provider.
  async request(
    apiKey: string,
    model: string,
    input: SummaryInput,
    signal: AbortSignal,
    timeout: number,
  ): Promise<string> {
    const result = await new GoogleGenAI({ apiKey }).models.generateContent({
      model,
      contents: JSON.stringify(input),
      config: {
        systemInstruction: SUMMARY_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: summaryResponseSchema(input),
        abortSignal: signal,
        httpOptions: { timeout, retryOptions: { attempts: 1 } },
      },
    });
    return result.text ?? '';
  }
  async generate(
    input: SummaryInput,
    shutdown?: AbortSignal,
  ): Promise<{ summary: string; model: string; detail: SummaryDetail }> {
    const key = this.config.get<string>('GEMINI_API_KEY')?.trim();
    const model = this.config.get<string>('GEMINI_MODEL')?.trim();
    if (!key || !model) throw new SummaryError('GEMINI_CONFIG');
    const timeout = positiveSetting(this.config, 'GEMINI_TIMEOUT_MS', 15000);
    const started = performance.now();
    const controller = new AbortController();
    let expired = false;
    const stop = () => controller.abort();
    shutdown?.addEventListener('abort', stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (shutdown?.aborted) throw new SummaryError('SUMMARY_SHUTDOWN', true);
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () =>
            reject(
              new SummaryError(
                expired ? 'GEMINI_TIMEOUT' : 'SUMMARY_SHUTDOWN',
                true,
              ),
            ),
          { once: true },
        ),
      );
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
      }, timeout);
      const text = await Promise.race([
        this.request(key, model, input, controller.signal, timeout),
        aborted,
      ]);
      const { summary, ...detail } = validateSummary(text, input);
      this.logger.log(
        `Gemini summary completed: model=${JSON.stringify(safeModelLabel(model))} timeoutMs=${timeout} durationMs=${Math.round(performance.now() - started)}`,
      );
      return { summary, model, detail };
    } catch (error) {
      // Only bounded HTTP status and our own codes are safe to log. SDK errors
      // may contain credentials, request URLs, inputs or response contents.
      const rawStatus = (error as { status?: unknown } | null)?.status;
      const status =
        typeof rawStatus === 'number' &&
        Number.isInteger(rawStatus) &&
        rawStatus >= 100 &&
        rawStatus <= 599
          ? rawStatus
          : undefined;
      let failure: SummaryError;
      if (error instanceof SummaryError) failure = error;
      else if (status === 401 || status === 403)
        failure = new SummaryError('GEMINI_AUTH');
      else if (status === 429)
        failure = new SummaryError(
          'GEMINI_RATE_LIMIT',
          this.config.get('GEMINI_SUMMARY_RATE_LIMIT_POLICY') === 'retry',
        );
      else if (status !== undefined && status >= 500)
        failure = new SummaryError('GEMINI_UNAVAILABLE', true);
      else {
        const code = (error as { code?: string } | null)?.code;
        failure =
          ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(
            code ?? '',
          ) || error instanceof TypeError
            ? new SummaryError('GEMINI_NETWORK', true)
            : new SummaryError('GEMINI_REQUEST_FAILED');
      }
      this.logger.warn(
        `Gemini summary failed: status=${status ?? 'unknown'} code=${failure.code} retryable=${failure.retryable} model=${JSON.stringify(safeModelLabel(model))} timeoutMs=${timeout} durationMs=${Math.round(performance.now() - started)} reason=${safeGeminiMessage(error)}`,
      );
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      shutdown?.removeEventListener('abort', stop);
    }
  }
}
