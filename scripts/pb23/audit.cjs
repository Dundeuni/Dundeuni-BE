const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parse } = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const config = parse(fs.readFileSync('.env'));
const url = new URL(config.DATABASE_URL);
const prisma = new PrismaClient({ datasourceUrl: url.toString() });
(async () => {
  try {
    console.log(
      'DATABASE',
      JSON.stringify({
        host: url.hostname,
        database: url.pathname.slice(1),
        schema: url.searchParams.get('schema') || 'public',
        environment: config.NODE_ENV,
      }),
    );
    console.log(
      'SERVER',
      JSON.stringify(
        await prisma.$queryRawUnsafe(
          'SELECT current_database() AS database, version() AS version, pg_is_in_recovery() AS recovery',
        ),
      ),
    );
    const rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name, checksum, started_at, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
    );
    const branch = 'feature/#7-gemini-analysis-summary';
    for (const row of rows) {
      let current = null,
        summary = null;
      const path = `prisma/migrations/${row.migration_name}/migration.sql`;
      if (fs.existsSync(path))
        current =
          crypto
            .createHash('sha256')
            .update(fs.readFileSync(path))
            .digest('hex') === row.checksum;
      try {
        summary =
          crypto
            .createHash('sha256')
            .update(
              execFileSync('git', ['show', `${branch}:${path}`], {
                stdio: ['ignore', 'pipe', 'ignore'],
              }),
            )
            .digest('hex') === row.checksum;
      } catch {}
      console.log(
        'MIGRATION',
        JSON.stringify({
          ...row,
          checksum: undefined,
          currentChecksumMatches: current,
          summaryChecksumMatches: summary,
        }),
      );
    }
    console.log(
      'COUNTS',
      JSON.stringify(
        await prisma.$queryRawUnsafe(
          'SELECT (SELECT count(*)::int FROM analysis_requests) AS analyses, (SELECT count(*)::int FROM analysis_model_results) AS models',
        ),
      ),
    );
    console.log(
      'TABLES',
      JSON.stringify(
        await prisma.$queryRawUnsafe(
          "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
        ),
      ),
    );
  } catch (error) {
    console.error('Audit failed:', error.code || error.name);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
