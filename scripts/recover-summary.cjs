// Host/DB access is the admin boundary. Never bootstrap Nest (which starts workers).
require('dotenv').config({ quiet: true });
const { ConfigService } = require('@nestjs/config');
const { PrismaClient } = require('@prisma/client');
const {
  AnalysisSummaryRepository,
} = require('../dist/domains/analysis/analysis-summary.repository');
const {
  SummaryError,
} = require('../dist/domains/analysis/gemini-summary.client');
(async () => {
  const id = process.argv[2];
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id ?? '',
    ) ||
    process.argv[3] !== '--confirm'
  ) {
    console.error('Usage: npm run summary:recover -- <analysisId> --confirm');
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaClient();
  try {
    console.log(
      JSON.stringify(
        await new AnalysisSummaryRepository(
          prisma,
          new ConfigService(),
        ).recoverFailed(id),
      ),
    );
  } catch (error) {
    console.error(
      error instanceof SummaryError ? error.code : 'SUMMARY_RECOVERY_DB_ERROR',
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
