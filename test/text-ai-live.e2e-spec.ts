import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AnalysisRepository } from '../src/domains/analysis/analysis.repository';
import { IMAGE_ANALYSIS_PROVIDER } from '../src/domains/analysis/image-analysis.service';
import { HttpTextAnalysisProvider } from '../src/domains/analysis/http-text-analysis.provider';
import {
  validateTextRiskResponse,
  storedTextRiskResult,
} from '../src/domains/analysis/text-risk.dto';
import { TEXT_RETENTION_MS } from '../src/domains/analysis/text-analysis.input';

// Explicit opt-in only: ordinary tests can never contact a real AI server.
const liveDescribe = process.env.AI_E2E_LIVE === '1' ? describe : describe.skip;
liveDescribe(
  'real TEXT AI direct / backend / isolated PostgreSQL matrix',
  () => {
    it('runs synthetic direct and backend cases, then OCR→repository; stops on the first failure', async () => {
      const base = process.env.AI_SERVICE_BASE_URL;
      const token =
        process.env.TEXT_AI_SERVICE_TOKEN ?? process.env.AI_SERVICE_TOKEN;
      const db = process.env.AI_E2E_DB_URL;
      if (!base || !token || !db)
        throw Error('Explicit live AI credentials and isolated DB required');
      const target = new URL(base),
        database = new URL(db);
      if (
        target.protocol !== 'https:' ||
        target.hostname !== 'kissable-rust-strung.ngrok-free.dev' ||
        target.username ||
        target.password ||
        target.search ||
        target.hash
      )
        throw Error('Live AI endpoint guard');
      if (
        !['localhost', '127.0.0.1'].includes(database.hostname) ||
        !/^pb23_test_\d+$/.test(database.pathname.slice(1))
      )
        throw Error('Live test database guard');
      const config = new ConfigService({
        TEXT_AI_PROVIDER: 'http',
        AI_SERVICE_BASE_URL: base,
        AI_SERVICE_TOKEN: token,
        AI_REQUEST_TIMEOUT_MS: '45000',
        ANALYSIS_MAX_FILE_BYTES: '10485760',
        ANALYSIS_RETENTION_SECONDS: '86400',
      });
      const provider = new HttpTextAnalysisProvider(config);
      const prisma = new PrismaClient({ datasourceUrl: db });
      const repository = new AnalysisRepository(
        prisma as unknown as PrismaService,
      );
      let app: INestApplication | undefined;
      const records: Record<string, unknown>[] = [];
      const samples = [
        [
          'general-notice',
          '도서관 안내입니다. 내일 오전 열 시부터 정기 시설 점검이 예정되어 있습니다.',
        ],
        [
          'parcel-impersonation',
          '배송 주소 오류로 반송 예정입니다. 아래 링크에서 주소와 배송비를 확인해 주세요. https://example.invalid/delivery',
        ],
        [
          'bank-impersonation',
          '가상은행 안내입니다. 계좌가 정지되었습니다. 아래 링크에서 계좌정보와 비밀번호를 입력해 주세요. https://example.invalid/verify',
        ],
        [
          'urgent-transfer',
          '급하게 송금이 필요합니다. 지금 바로 돈을 보내 주세요. 다른 사람에게 확인하지 말고 즉시 처리해 주세요.',
        ],
      ];
      const outcomePath =
        process.env.AI_E2E_RESULT_PATH ??
        join(tmpdir(), `text-ai-live-${Date.now()}.json`);
      try {
        // No expected classifications: schema/correlation only, never force model answers.
        for (const [scenario, text] of samples) {
          const context = {
            analysisId: randomUUID(),
            elementId: randomUUID(),
            sourceType: 'TEXT' as const,
          };
          try {
            const raw = await provider.analyze(
              { ...context, userId: 'synthetic-test', text },
              AbortSignal.timeout(45000),
            );
            const result = validateTextRiskResponse(raw, context);
            records.push({
              stage: 'direct',
              scenario,
              httpStatus: 200,
              result: storedTextRiskResult(result),
            });
          } catch (error) {
            records.push({
              stage: 'direct',
              scenario,
              outcome: 'FAIL',
              failureKind: (error as { failureKind?: string }).failureKind,
              upstreamStatus: (error as { upstreamStatus?: number })
                .upstreamStatus,
            });
            throw Error(
              'Live direct TEXT request failed; remaining live calls stopped',
            );
          }
        }
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(ConfigService)
          .useValue(config)
          .overrideProvider(PrismaService)
          .useValue(prisma)
          .overrideProvider(IMAGE_ANALYSIS_PROVIDER)
          .useValue({
            analyze: async () => {
              throw Error('Live TEXT matrix must not call IMAGE provider');
            },
          })
          .compile();
        app = module.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(
          new ValidationPipe({ transform: true, whitelist: true }),
        );
        await app.init();
        await app.listen(0, '127.0.0.1');
        for (const [scenario, text] of samples) {
          const key = 'live-text-' + randomUUID();
          const response = await request(app.getHttpServer())
            .post('/api/analysis')
            .set('Idempotency-Key', key)
            .send({ type: 'TEXT', text });
          if (response.status !== 202) {
            records.push({
              stage: 'backend-db',
              scenario,
              httpStatus: response.status,
              code: response.body.code,
            });
            throw Error(
              'Live backend request failed; remaining live calls stopped',
            );
          }
          const row = await prisma.analysis.findUniqueOrThrow({
            where: { id: response.body.result.analysisId },
          });
          expect(row.status).toBe('COMPLETED');
          expect(row.type).toBe('TEXT');
          expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
            TEXT_RETENTION_MS,
          );
          expect(row.aiGenerationScore).toBeNull();
          expect(row.aiRiskLevel).toBeNull();
          const replay = await request(app.getHttpServer())
            .post('/api/analysis')
            .set('Idempotency-Key', key)
            .send({ type: 'TEXT', text });
          expect(replay.status).toBe(202);
          expect(
            createHash('sha256')
              .update(JSON.stringify(replay.body))
              .digest('hex'),
          ).toBe(
            createHash('sha256')
              .update(JSON.stringify(response.body))
              .digest('hex'),
          );
          records.push({
            stage: 'backend-db',
            scenario,
            httpStatus: response.status,
            analysisId: row.id,
            status: row.status,
            result: row.textResult,
          });
        }
        // No public OCR route exists. Exercise the actual provider and repository directly without changing IMAGE semantics.
        const svg =
          '<svg width="1100" height="330" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g fill="black" font-family="Apple SD Gothic Neo, sans-serif" font-size="38"><text x="30" y="70">[테스트 문자] 가상은행 안내</text><text x="30" y="140">계좌가 정지되었습니다. 지금 본인 인증을 해 주세요.</text><text x="30" y="210">https://example.invalid/verify</text></g></svg>';
        const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
        const createdAt = new Date();
        const elementId = randomUUID();
        const analysisId = randomUUID();
        await prisma.analysis.create({
          data: {
            id: analysisId,
            userId: 'synthetic-ocr-test',
            type: 'TEXT',
            status: 'ANALYZING',
            requestHash: createHash('sha256')
              .update('TEXT_OCR\0')
              .update(buffer)
              .digest('hex'),
            createdAt,
            updatedAt: createdAt,
            expiresAt: new Date(createdAt.getTime() + TEXT_RETENTION_MS),
          },
        });
        try {
          const context = {
            analysisId,
            elementId,
            sourceType: 'SCREEN_CROP' as const,
          };
          const raw = await provider.analyzeImage(
            { buffer, mimetype: 'image/png' } as Express.Multer.File,
            context,
            AbortSignal.timeout(45000),
          );
          const result = validateTextRiskResponse(raw, context);
          const row = await repository.completeText(
            analysisId,
            storedTextRiskResult(result),
          );
          expect(row.status).toBe('COMPLETED');
          expect(row.textPreview).toBeNull();
          records.push({
            stage: 'ocr-provider-db',
            httpStatus: 200,
            analysisId,
            status: row.status,
            result: row.textResult,
          });
        } catch (error) {
          await repository
            .fail(analysisId, 'ANALYSIS503')
            .catch(() => undefined);
          records.push({
            stage: 'ocr-provider-db',
            outcome: 'FAIL',
            upstreamStatus: (error as { upstreamStatus?: number })
              .upstreamStatus,
          });
          throw Error('Live OCR request failed');
        } finally {
          buffer.fill(0);
        }
      } finally {
        await app?.close();
        await prisma.$disconnect();
        writeFileSync(outcomePath, JSON.stringify(records, null, 2), {
          mode: 0o600,
        });
        console.log('Sanitized live result metadata:', outcomePath);
      }
    }, 600000);
  },
);
