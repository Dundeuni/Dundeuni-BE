// Dry-run by default. --execute sends to a local BE, which may forward to the real AI server.
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');
const { PNG } = require('pngjs');
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set([
    '--execute',
    '--file',
    '--be-url',
    '--verify-db',
    '--analysis-id',
  ]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key)) throw new Error('Unsupported argument');
    if (key === '--execute') options.execute = true;
    else if (key === '--verify-db') options.verifyDb = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw new Error('Missing argument value');
      options[key] = args[++i];
    }
  }
  const config = {
    ...(fs.existsSync('.env') ? parse(fs.readFileSync('.env')) : {}),
    ...process.env,
  };
  if (options['--analysis-id']) {
    if (!options.verifyDb || options.execute)
      throw new Error('--analysis-id requires --verify-db without --execute');
    await verifyDatabase(options['--analysis-id'], config);
    return;
  }
  if (options.verifyDb && !options.execute)
    throw new Error('--verify-db requires --execute or --analysis-id');
  const url = new URL(
    options['--be-url'] || 'http://127.0.0.1:3000/api/analysis',
  );
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Only a loopback HTTP BE URL is allowed');
  const file = path.resolve(
    options['--file'] || 'test/fixtures/non-sensitive-pattern-256x192.png',
  );
  const bytes = fs.readFileSync(file);
  if (bytes.length > 10 * 1024 * 1024) throw new Error('PNG exceeds 10 MiB');
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Invalid PNG header');
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    width < 32 ||
    height < 32 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16000000
  )
    throw new Error('PNG dimensions violate v0.2');
  const decoded = PNG.sync.read(bytes, { checkCRC: true });
  const timeout = Number(config.AI_REQUEST_TIMEOUT_MS || 30000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147473647)
    throw new Error('Invalid AI_REQUEST_TIMEOUT_MS');
  console.log(
    JSON.stringify(
      {
        mode: options.execute ? 'execute' : 'dry-run (no network)',
        beUrl: url.href,
        image: {
          width: decoded.width,
          height: decoded.height,
          bytes: bytes.length,
        },
        provider: config.AI_PROVIDER || 'unavailable',
        tokenConfigured: !!config.AI_SERVICE_TOKEN?.trim(),
        serverUrlConfigured: !!config.AI_SERVER_BASE_URL?.trim(),
        aiTimeoutMs: timeout,
        meetsSequentialDevelopmentBudget: timeout >= 241000,
      },
      null,
      2,
    ),
  );
  if (!options.execute) return;
  if (
    config.AI_PROVIDER !== 'http' ||
    !config.AI_SERVICE_TOKEN?.trim() ||
    !config.AI_SERVER_BASE_URL?.trim()
  )
    throw new Error(
      'Configure and restart the local BE in http mode before executing',
    );
  const form = new FormData();
  form.append('type', 'IMAGE');
  form.append(
    'file',
    new Blob([bytes], { type: 'image/png' }),
    'non-sensitive-test.png',
  );
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    redirect: 'error',
    signal: AbortSignal.timeout(timeout + 10000),
  });
  const body = await response.json();
  console.log(
    JSON.stringify(
      {
        httpStatus: response.status,
        elapsedMs: Date.now() - started,
        isSuccess: body.isSuccess,
        code: body.code,
        analysisId: body.result?.analysisId,
        status: body.result?.status,
        aiGenerationScore: body.result?.aiGenerationScore,
        errorCode: body.result?.errorCode,
      },
      null,
      2,
    ),
  );
  if (
    response.status !== 202 ||
    body.isSuccess !== true ||
    body.code !== 'ANALYSIS202'
  ) {
    process.exitCode = 1;
    return;
  }
  if (options.verifyDb)
    await verifyDatabase(body.result?.analysisId, config, body.result);
}
async function verifyDatabase(analysisId, config, publicResult) {
  if (
    typeof analysisId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      analysisId,
    )
  )
    throw new Error('Valid analysisId required for repository lookup');
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL required');
  require('reflect-metadata');
  require('ts-node/register/transpile-only');
  const { PrismaClient } = require('@prisma/client');
  const {
    AnalysisRepository,
  } = require('../src/domains/analysis/analysis.repository');
  const {
    calculateOverallResult,
  } = require('../src/domains/analysis/image-analysis-policy');
  const prisma = new PrismaClient({
    datasourceUrl: config.DATABASE_URL,
    log: [],
  });
  try {
    const saved = await new AnalysisRepository(prisma).findWithModelResults(
      analysisId,
    );
    if (!saved) throw new Error('Analysis missing from configured database');
    const generation =
      saved.modelResults.find((m) => m.kind === 'GENERATION') ?? null;
    const manipulation =
      saved.modelResults.find((m) => m.kind === 'MANIPULATION') ?? null;
    const publicMatches = publicResult
      ? publicResult.status === saved.status &&
        publicResult.aiGenerationScore === saved.aiGenerationScore &&
        publicResult.modelVersion === saved.modelVersion &&
        publicResult.errorCode === saved.errorCode
      : null;
    const model = (value) =>
      value && {
        modelName: value.modelName,
        status: value.status,
        decision: value.decision,
        displayScore: value.displayScore,
        reasons: value.reasons,
        limitations: value.limitations,
        errorCode: value.errorCode,
      };
    let output = JSON.stringify(
      {
        verification:
          'Prisma Repository read (does not prove upstream HTTP execution)',
        analysisId,
        databaseFound: true,
        status: saved.status,
        imageResultStatus: saved.imageResultStatus,
        modelCount: saved.modelResults.length,
        publicResponseMatchesDatabase: publicMatches,
        generation: model(generation),
        manipulation: model(manipulation),
        overallResult: calculateOverallResult(generation, manipulation),
        overallResultSource: 'reconstructed from persisted model results',
      },
      null,
      2,
    );
    for (const [key, value] of Object.entries(config)) {
      if (/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL/.test(key) && value) {
        output = output.split(value).join('[REDACTED]');
        if (value.trim())
          output = output.split(value.trim()).join('[REDACTED]');
      }
    }
    console.log(output);
    if (!generation || !manipulation || (publicResult && !publicMatches))
      process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
main().catch(() => {
  console.error(
    'Local smoke preflight/request failed; check image, local BE and configuration. Sensitive error details omitted.',
  );
  process.exitCode = 1;
});
