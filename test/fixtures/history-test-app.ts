import { AnalysisExpiryCleanupService } from '../../src/domains/analysis/analysis-expiry-cleanup.service';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { IMAGE_ANALYSIS_PROVIDER } from '../../src/domains/analysis/image-analysis.service';

export const historySecret = 'history-only-test-secret';
export function historyToken(
  sub = 'alice',
  exp = Math.floor(Date.now() / 1000) + 3600,
) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString(
    'base64url',
  );
  return `${header}.${payload}.${createHmac('sha256', historySecret).update(`${header}.${payload}`).digest('base64url')}`;
}

export async function historyTestApp(
  prisma: unknown,
  provider: unknown,
): Promise<INestApplication> {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(
      new ConfigService({
        NODE_ENV: 'development',
        JWT_ACCESS_SECRET: historySecret,
        ANALYSIS_MAX_FILE_BYTES: '100000',
        ANALYSIS_RETENTION_SECONDS: '86400',
      }),
    )
    .overrideProvider(AnalysisExpiryCleanupService)
    .useValue({})
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
    .useValue(provider)
    .compile();
  const app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.init();
  return app;
}
