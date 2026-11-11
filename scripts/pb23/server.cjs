require('ts-node/register/transpile-only');
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { PrismaClient } = require('@prisma/client');
const {
  AnalysisController,
} = require('../../src/domains/analysis/analysis.controller');
const {
  AnalysisService,
} = require('../../src/domains/analysis/analysis.service');
const {
  AnalysisRepository,
} = require('../../src/domains/analysis/analysis.repository');
const {
  AnalysisUsageService,
} = require('../../src/domains/analysis/analysis-usage.service');
const {
  ImageAnalysisService,
  IMAGE_ANALYSIS_PROVIDER,
} = require('../../src/domains/analysis/image-analysis.service');
const {
  MockImageAnalysisProvider,
} = require('../../src/domains/analysis/mock-image-analysis.provider');
const { ApiError } = require('../../src/common/http/api-error');
const url = new URL(process.env.PB23_DB_URL);
if (!/^pb23_test_\d+$/.test(url.pathname.slice(1)))
  throw Error('Isolated test DB required');
const prisma = new PrismaClient({ datasourceUrl: url.toString() });
const metrics = { ai: 0, reserve: 0, release: 0, conflicts: 0 };
let fail = false,
  app;
const repository = new AnalysisRepository(prisma);
const claim = repository.claim.bind(repository);
repository.claim = async (...args) => {
  const result = await claim(...args);
  if (!result.claimed) metrics.conflicts++;
  return result;
};
(async () => {
  const module = await Test.createTestingModule({
    controllers: [AnalysisController],
    providers: [
      AnalysisService,
      ImageAnalysisService,
      {
        provide: ConfigService,
        useValue: new ConfigService({
          NODE_ENV: 'development',
          ANALYSIS_MAX_FILE_BYTES: '100000',
          ANALYSIS_RETENTION_SECONDS: '86400',
          AI_REQUEST_TIMEOUT_MS: '5000',
        }),
      },
      { provide: AnalysisRepository, useValue: repository },
      {
        provide: AnalysisUsageService,
        useValue: {
          reserveAiUsage: async () => {
            metrics.reserve++;
          },
          releaseAiUsage: async () => {
            metrics.release++;
          },
        },
      },
      {
        provide: IMAGE_ANALYSIS_PROVIDER,
        useValue: {
          analyze: async (file, context, signal) => {
            metrics.ai++;
            await new Promise((r) => setTimeout(r, 400));
            if (fail)
              throw new ApiError(
                503,
                'ANALYSIS503',
                '이미지 분석을 수행할 수 없습니다.',
              );
            return new MockImageAnalysisProvider('BOTH_SUCCESS').analyze(
              file,
              context,
              signal,
            );
          },
        },
      },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.listen(0, '127.0.0.1');
  process.send({ ready: true, port: app.getHttpServer().address().port });
  process.on('message', async (msg) => {
    if (msg.command === 'metrics') process.send({ id: msg.id, ...metrics });
    if (msg.command === 'fail') {
      fail = msg.value;
      process.send({ id: msg.id, ok: true });
    }
    if (msg.command === 'close') {
      await app.close();
      await prisma.$disconnect();
      process.exit(0);
    }
  });
})().catch(() => {
  process.send?.({ error: 'Test server failed' });
  process.exit(1);
});
