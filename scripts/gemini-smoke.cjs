// No Nest bootstrap/DB/worker/image input. One request, SDK retries disabled.
require('dotenv').config({ quiet: true });
const { GoogleGenAI } = require('@google/genai');
const {
  safeGeminiMessage,
  safeModelLabel,
} = require('../dist/domains/analysis/gemini-summary.client');
(async () => {
  const key = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  const timeout = Number(process.env.GEMINI_TIMEOUT_MS ?? 15000);
  if (
    !key ||
    !model ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0 ||
    timeout > 3600000
  ) {
    console.error('GEMINI_CONFIG: set key/model/positive timeout');
    process.exitCode = 1;
    return;
  }
  const started = performance.now();
  console.log(
    JSON.stringify({ model: safeModelLabel(model), timeoutMs: timeout }),
  );
  try {
    const result = await new GoogleGenAI({
      apiKey: key,
    }).models.generateContent({
      model,
      contents: '한국어로 안녕하세요 한 단어만 답하세요.',
      config: {
        abortSignal: AbortSignal.timeout(timeout),
        httpOptions: { timeout, retryOptions: { attempts: 1 } },
      },
    });
    // Response body is deliberately omitted, even for this public fixed prompt.
    console.log(
      JSON.stringify({
        success: Boolean(result.text?.trim()),
        responseChars: result.text?.length ?? 0,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    if (!result.text?.trim()) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        success: false,
        status:
          Number.isInteger(error?.status) &&
          error.status >= 100 &&
          error.status <= 599
            ? error.status
            : 'unknown',
        reason: safeGeminiMessage(error),
        durationMs: Math.round(performance.now() - started),
      }),
    );
    process.exitCode = 1;
  }
})();
